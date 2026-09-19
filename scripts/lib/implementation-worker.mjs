import path from 'node:path';
import { access } from 'node:fs/promises';
import { McpClient } from './mcp-client.mjs';
import { subscriptionEnv } from './bridge-process.mjs';
import { redactText } from './redact.mjs';
import { harnessError } from './harness-errors.mjs';

const REQUIRED_TOOLS = Object.freeze(['antigravity_execute', 'antigravity_continue', 'antigravity_result']);

function requireText(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw harnessError('INVALID_INPUT', message);
  return value.trim();
}

export function assertWorkerIsolation(config) {
  // The current Windows host has no restricted worker identity, ACL launcher,
  // or sandbox. Test fixtures inject a fake worker and opt into test_mode;
  // real MCP dispatch fails closed until an OS boundary is supplied.
  if (config?.test_mode === true) return { mode: 'test-fixture' };
  throw harnessError(
    'WORKER_ISOLATION_UNAVAILABLE',
    'Antigravity worker isolation is unavailable; refusing to start an unrestricted worker'
  );
}

function operationArgs(operation) {
  if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string' ||
      !['execute', 'continue'].includes(operation.kind) ||
      !Number.isInteger(operation.attempt) || operation.attempt < 1 ||
      !Number.isInteger(operation.rework_count) || operation.rework_count < 0) {
    throw harnessError('MCP_RESULT_CORRELATION_MISMATCH', 'external worker operation metadata is invalid');
  }
  return {
    operation_id: operation.id,
    invocation_kind: operation.kind,
    attempt: operation.attempt,
    rework_count: operation.rework_count
  };
}

function under(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export class ImplementationWorker {
  async execute() { throw new Error('ImplementationWorker.execute is not implemented'); }
  async continue() { throw new Error('ImplementationWorker.continue is not implemented'); }
  async result() { throw new Error('ImplementationWorker.result is not implemented'); }
  async close() {}
}

export class AntigravityMcpWorker extends ImplementationWorker {
  constructor({ repoRoot, worktreeRoot, config, timeoutSeconds = 300 } = {}) {
    super();
    this.repoRoot = path.resolve(repoRoot);
    this.worktreeRoot = path.resolve(worktreeRoot);
    this.config = config;
    this.timeoutSeconds = timeoutSeconds;
    this.client = null;
    this.toolNames = [];
  }

  #command() {
    const binding = this.config?.worker;
    if (binding?.transport !== 'mcp' || binding.server !== 'antigravity_worker') {
      throw harnessError('CONFIG_MISMATCH', 'MCP Antigravity worker binding is required');
    }
    if (!Array.isArray(binding.command) || binding.command.length < 1 || binding.command.length > 2) {
      throw harnessError('CONFIG_MISMATCH', 'MCP worker command must contain an executable and optional script');
    }
    if (binding.command.some(value => typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value))) {
      throw harnessError('CONFIG_MISMATCH', 'MCP worker command contains an invalid value');
    }
    const command = [...binding.command];
    if (command.length === 2 && !path.isAbsolute(command[1])) command[1] = path.resolve(this.repoRoot, command[1]);
    if (command.length === 2 && !under(this.repoRoot, path.resolve(command[1]))) {
      throw harnessError('WORKER_UNAVAILABLE', 'MCP server script must be inside the project root');
    }
    return command;
  }

  async #connect() {
    if (this.client) return;
    assertWorkerIsolation(this.config);
    const command = this.#command();
    if (command.length === 2) {
      try { await access(command[1]); }
      catch (error) { throw harnessError('MCP_UNAVAILABLE', `MCP server script is unavailable: ${error.message}`); }
    }
    const serverCwd = path.resolve(this.repoRoot, this.config.worker.cwd ?? '.');
    if (!under(this.repoRoot, serverCwd)) throw harnessError('WORKER_UNAVAILABLE', 'MCP server cwd must be inside the project root');
    const env = {
      ...subscriptionEnv(),
      WORKTREE_ROOT: this.worktreeRoot,
      ANTIGRAVITY_CLI: this.config.worker.cli ?? 'agy',
      ANTIGRAVITY_TIMEOUT_SECONDS: String(this.timeoutSeconds),
      ANTIGRAVITY_SKIP_PERMISSIONS: this.config.worker.skip_permissions === true ? 'true' : 'false'
    };
    this.client = new McpClient({
      command,
      cwd: serverCwd,
      env,
      timeoutMs: Math.max(1, this.timeoutSeconds) * 1000
    });
    try {
      const listing = await this.client.connect();
      this.toolNames = listing.tools.map(tool => tool?.name).filter(name => typeof name === 'string');
      const missing = REQUIRED_TOOLS.filter(name => !this.toolNames.includes(name));
      if (missing.length) throw harnessError('MCP_UNAVAILABLE', `MCP worker missing tools: ${missing.join(', ')}`);
    } catch (error) {
      const detail = this.client.summary().stderr;
      await this.client.close();
      this.client = null;
      if (['CONFIG_MISMATCH', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'MCP_PROTOCOL_ERROR'].includes(error?.harness?.code)) throw error;
      throw harnessError('MCP_UNAVAILABLE', `${error.message}${detail ? `; stderr: ${detail}` : ''}`);
    }
  }

  async #call(name, args) {
    await this.#connect();
    let result;
    try { result = await this.client.callTool(name, args); }
    catch (error) {
      if (error?.harness) throw error;
      const code = /timed out/i.test(error?.message ?? '') ? 'WORKER_TIMEOUT' : 'MCP_UNAVAILABLE';
      throw harnessError(code, `${name} failed: ${error.message}`);
    }
    if (!result || typeof result !== 'object') throw harnessError('MCP_PROTOCOL_ERROR', `MCP ${name} returned an invalid result`);
    return result;
  }

  async execute(task, prompt, operation) {
    const taskId = requireText(task?.task_id, 'task_id is required');
    const result = await this.#call('antigravity_execute', { task_id: taskId, ...operationArgs(operation), prompt: requireText(prompt, 'prompt is required') });
    return this.#validateResult(result, taskId);
  }

  async continue(task, instruction, operation) {
    const taskId = requireText(task?.task_id, 'task_id is required');
    const result = await this.#call('antigravity_continue', { task_id: taskId, ...operationArgs(operation), instruction: requireText(instruction, 'instruction is required') });
    return this.#validateResult(result, taskId);
  }

  async result(task) {
    const taskId = requireText(task?.task_id, 'task_id is required');
    return this.#validateResult(await this.#call('antigravity_result', { task_id: taskId }), taskId);
  }

  async tools() {
    await this.#connect();
    return [...this.toolNames];
  }

  async health() {
    const tools = await this.tools();
    return { status: 'AVAILABLE', tools, server: this.config.worker.server, cwd: this.client?.cwd ?? null };
  }

  #validateResult(result, taskId) {
    if (result.task_id !== taskId) throw harnessError('MCP_PROTOCOL_ERROR', 'MCP result task_id mismatch');
    if (typeof result.workspace !== 'string' || path.resolve(result.workspace) !== path.resolve(this.worktreeRoot, taskId)) {
      throw harnessError('WORKTREE_ESCAPE', 'MCP result workspace does not match the resolved task worktree');
    }
    return {
      task_id: taskId,
      status: result.status ?? null,
      agent_status: result.agent_status ?? null,
      exit_code: result.exit_code ?? null,
      timed_out: result.timed_out === true,
      output_limited: result.output_limited === true,
      operation_id: result.operation_id ?? null,
      invocation_kind: result.invocation_kind ?? null,
      attempt: Number.isInteger(result.attempt) ? result.attempt : null,
      rework_count: Number.isInteger(result.rework_count) ? result.rework_count : null,
      conversation_id: result.conversation_id ?? null,
      observed_model: result.observed_model ?? null,
      observed_agent: result.observed_agent ?? null,
      started_at: result.started_at ?? null,
      finished_at: result.finished_at ?? null,
      final_summary: result.final_summary ?? null,
      error: redactText(typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? '')),
      error_code: result.error_code ?? null,
      stderr: redactText(String(result.stderr ?? '')),
      mcp_tools: [...this.toolNames]
    };
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.toolNames = [];
  }
}

export const ANTIGRAVITY_MCP_TOOLS = REQUIRED_TOOLS;
