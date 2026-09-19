from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

from mcp import Client, StdioServerParameters


MODULE_PATH = Path(__file__).with_name("antigravity_server.py")
SPEC = importlib.util.spec_from_file_location("antigravity_worker_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)

FAKE_OUTPUT = (
    '@echo off\r\n'
    'echo {"event":"init","conversation_id":"smoke-conversation","init":{"model":"fake-antigravity","agent":"fake-agent"}}\r\n'
    'echo {"event":"step_update","step_update":{"conversation_id":"smoke-conversation","step_type":"agent_response","text_delta":"smoke ok"}}\r\n'
    'echo {"event":"result","result":{"conversation_id":"smoke-conversation","status":"SUCCESS","response":"smoke ok"}}\r\n'
)


async def smoke() -> None:
    with tempfile.TemporaryDirectory(prefix="antigravity-mcp-") as temp:
        temp_path = Path(temp)
        root = temp_path / "worktrees"
        workspace = root / "TASK-SMOKE"
        workspace.mkdir(parents=True)
        fake_cli = temp_path / "fake-agy.cmd"
        fake_cli.write_text(FAKE_OUTPUT, encoding="utf-8")
        old_env = os.environ.copy()
        os.environ.update({"WORKTREE_ROOT": str(root), "ANTIGRAVITY_CLI": str(fake_cli), "ANTIGRAVITY_TIMEOUT_SECONDS": "10", "ANTIGRAVITY_SKIP_PERMISSIONS": "true", "ANTIGRAVITY_FAKE_CLI_TEST_MODE": "true"})
        SERVER._states.clear()
        try:
            first = await SERVER.antigravity_execute("TASK-SMOKE", "op-execute", "edit a test file", "execute", 1, 0)
            assert first["status"] == "SUCCEEDED"
            assert first["operation_id"] == "op-execute"
            continued = await SERVER.antigravity_continue("TASK-SMOKE", "op-continue", "run the test again", "continue", 2, 1)
            assert continued["status"] == "SUCCEEDED"
            assert continued["operation_id"] == "op-continue"
            assert continued["conversation_id"] == "smoke-conversation"
            latest = await SERVER.antigravity_result("TASK-SMOKE")
            assert latest["operation_id"] == "op-continue"
            assert latest["invocation_kind"] == "continue"
            assert latest["attempt"] == 2
            assert latest["rework_count"] == 1
            SERVER._states.clear()
            after_restart = await SERVER.antigravity_result("TASK-SMOKE")
            assert after_restart["status"] == "NO_RESULT"
            assert after_restart["error_code"] == "NO_RESULT"
            try:
                SERVER.resolve_workspace("TASK-../escape")
            except ValueError:
                pass
            else:
                raise AssertionError("path traversal was not rejected")
        finally:
            os.environ.clear()
            os.environ.update(old_env)


async def stdio_smoke() -> None:
    with tempfile.TemporaryDirectory(prefix="antigravity-mcp-stdio-") as temp:
        temp_path = Path(temp)
        root = temp_path / "worktrees"
        (root / "TASK-STDIO").mkdir(parents=True)
        fake_cli = temp_path / "fake-agy.cmd"
        fake_cli.write_text(FAKE_OUTPUT, encoding="utf-8")
        env = {**os.environ, "WORKTREE_ROOT": str(root), "ANTIGRAVITY_CLI": str(fake_cli), "ANTIGRAVITY_TIMEOUT_SECONDS": "10", "ANTIGRAVITY_SKIP_PERMISSIONS": "true", "ANTIGRAVITY_FAKE_CLI_TEST_MODE": "true"}
        params = StdioServerParameters(command=sys.executable, args=[str(MODULE_PATH)], env=env)
        async with Client(params) as client:
            tools = await client.list_tools()
            assert sorted(tool.name for tool in tools.tools) == ["antigravity_continue", "antigravity_execute", "antigravity_result"]
            call = await client.call_tool("antigravity_execute", {"task_id": "TASK-STDIO", "operation_id": "op-stdio", "prompt": "run the safe smoke test", "invocation_kind": "execute", "attempt": 1, "rework_count": 0})
            assert call.is_error is False
            assert call.structured_content["operation_id"] == "op-stdio"


async def fail_closed_smoke() -> None:
    with tempfile.TemporaryDirectory(prefix="antigravity-mcp-fail-closed-") as temp:
        root = Path(temp) / "worktrees"
        (root / "TASK-REAL").mkdir(parents=True)
        old_env = os.environ.copy()
        os.environ.update({
            "WORKTREE_ROOT": str(root),
            "ANTIGRAVITY_CLI": "agy",
            "ANTIGRAVITY_WORKER_ISOLATED": "true",
            "ANTIGRAVITY_FAKE_CLI_TEST_MODE": "false",
        })
        SERVER._states.clear()
        try:
            result = await SERVER.antigravity_execute("TASK-REAL", "op-real", "must not launch", "execute", 1, 0)
            assert result["error_code"] == "WORKER_ISOLATION_UNAVAILABLE"
        finally:
            os.environ.clear()
            os.environ.update(old_env)


if __name__ == "__main__":
    asyncio.run(smoke())
    asyncio.run(stdio_smoke())
    asyncio.run(fail_closed_smoke())
