# H-021 — production worker isolation design

## WORKER ISOLATION PROVISIONING PLAN READY

This document is a design and review artifact only. No Windows account, service,
ACL, scheduled task, firewall rule, feature, registry value, or production state
was changed while creating it.

## Environment discovery

- Identity: `DESKTOP-K0VINJM\QQ`.
- OS: Windows 11 Home Single Language, build `26200`, 64-bit, WORKGROUP (not a domain member).
- Volume `F:`: NTFS, healthy.
- Current process is not elevated. `fsutil fsinfo volumeinfo F:` returned Access Denied; the read-only volume query confirms NTFS.
- Runtime paths: `agy` at `C:\Users\QQ\AppData\Local\agy\bin\agy.exe`, Node at `C:\Program Files\nodejs\node.exe`, Python at `C:\Users\QQ\AppData\Local\Programs\Python\Python314\python.exe`, Git at `D:\Git\cmd\git.exe`.
- `agy --help` exposes no non-interactive auth provisioning command. A Windows Credential Manager entry named `gemini:antigravity` exists for user `antigravity`; relevant per-user locations include `%USERPROFILE%\.gemini` and Antigravity application profiles. Values were not read or printed.
- .NET runtime `10.0.12` is installed, but no .NET SDK is installed. No worker service binary is currently available to register.
- Codex MCP config is global at `C:\Users\QQ\.codex\config.toml`; the existing `qq_direct_antigravity` entry is a separate direct-route server. The repair worktree has no project-local `.codex/config.toml`.

## Selected architecture

```text
Harness / MCP broker (QQ)
        |
        | local Windows Named Pipe, ACL + client identity check
        v
Restricted worker service (AIWorker, non-admin)
        |
        | fixed executable, fixed environment, fixed timeout/job object
        v
agy / Antigravity runtime (AIWorker profile and credential store)
        |
        v
assigned task worktree only
```

The broker must not spawn `agy`. The existing `WORKER_ISOLATION_UNAVAILABLE`
fail-closed check remains correct until this service is installed and its
self-test proof is fresh.

## Trust model

- Harness/QQ is the trusted control plane. It owns lifecycle, claims, leases,
  review packets, checkpoints, receipts, audit and operations logs.
- AIWorker is the untrusted implementation plane. It may edit the assigned
  worktree and run tests, but has no filesystem write permission to control
  state or Harness source/config.
- The service accepts only `task_id`, `operation_id`, `kind`, optional
  `conversation_id`, and bounded `payload`. It never accepts `cwd`, an
  executable, a shell command, arbitrary environment variables, or a control
  path.
- The service resolves `WORKTREE_ROOT\task_id` itself and validates
  `^TASK-[A-Z0-9_-]+$`. It never checks out, resets, cleans, commits, resumes,
  retries, merges, publishes, or deploys.

## Account and credential model

- Create a local `AIWorker` account only; do not add it to Administrators,
  Users beyond the default required membership, Remote Desktop Users, or any
  privileged group.
- The provisioning script checks the account's local-group memberships and
  stops unless the only allowed built-in membership is `Users`.
- Register the service with Service Control Manager using a `SecureString`
  entered during provisioning. The Harness never receives or stores the
  password. The service manager owns the service logon secret.
- The provisioning script does not set a global execution policy, weaken UAC,
  or copy QQ's profile. The owner must complete one official Antigravity login
  for the AIWorker profile if `agy` requires it. A successful login must be
  verified under AIWorker; copying `%USERPROFILE%\\.gemini`, browser cookies,
  Credential Manager records, or whole Antigravity profiles is forbidden.
- The current auth dependency is not yet proven portable to AIWorker. This is
  an operational prerequisite, not something the Harness may work around.

## CONTROL_ROOT and WORKTREE_ROOT

Test-only defaults:

- `CONTROL_ROOT`: `F:\AI-Harness-Control-Test\`
- `WORKTREE_ROOT`: `F:\AI-Worker-Test\`
- service data/log root: `C:\ProgramData\QQ\AntigravityWorker-Test\`

The roots are independent of the source repository. The provisioning script
rejects drive roots, user/system/temp locations, pairwise-overlapping roots,
and paths without a `-Test` or `-Isolation` suffix. It refuses to overwrite an
existing directory.

## ACL plan

Inheritance is disabled at each isolated root before explicit rules are added.
The only broad principals allowed are `SYSTEM` and `BUILTIN\Administrators`.
`Everyone`, `Users`, and `Authenticated Users` are rejected by verification.

| Location | QQ/Harness | SYSTEM/Admin | AIWorker |
|---|---|---|---|
| CONTROL_ROOT and `ai-control`, `tasks`, `audit`, `operations`, `receipts` | Full | Full | no access |
| WORKTREE_ROOT | Full | Full | traverse only, no inherited write |
| assigned `TASK-*` directory | Full | Full | Modify with child inheritance |
| service data/log root | Full | Full | Modify |

The Harness must grant Modify to one assigned task directory and revoke the
previous assignment before reuse. The root-level AIWorker grant is not Modify;
this prevents a worker from writing another task by path guessing. Structural
ACL output is not acceptance: the self-test must run as AIWorker and verify
effective permissions for parent, child and spawned processes.

## IPC design

- Use a Windows Named Pipe, not a TCP listener and not an unauthenticated
  localhost port. No firewall change is expected.
- The pipe DACL grants connect/read/write only to the Harness identity,
  SYSTEM, and Administrators; it does not grant Everyone.
- The service additionally verifies the connected client token/SID before
  reading a request. A random local process with a different identity must be
  rejected.
- Use bounded framed JSON (one request and one response per connection),
  request size limits, operation correlation, timeout, redacted output and
  structured error codes.

## Worker service design

The service must be a real SCM-aware native service binary. A PowerShell script
or a Node/Python script by itself is not sufficient for production service
registration unless wrapped by a reviewed service host.

The service must:

1. start under `AIWorker` and verify its own SID;
2. use a machine-scoped, fixed `agy.exe` path (not QQ's profile path);
3. create a child-process Job Object with kill-on-close and enforce timeout;
4. pass a minimal allowlisted environment, not the Harness environment;
5. capture bounded stream-json output and redact secrets;
6. return `task_id`, `operation_id`, `kind`, `attempt`, `rework_count`, and
   `conversation_id` exactly as received/observed;
7. reject arbitrary path/executable/shell/environment input;
8. keep service logs in service data, never in CONTROL_ROOT audit/operations.

The current machine has no SDK and no reviewed native service binary, so this
phase intentionally does not register or claim a production worker service.

## External MCP contract and integration

Keep `antigravity_execute`, `antigravity_continue`, and `antigravity_result`.
Change only the implementation behind the broker: broker → Named Pipe service →
fixed worker service → `agy`. The broker must not retain the current direct
spawn path as a production fallback. `legacy_direct_cli=false` remains required
when isolation is required.

H-018 correlation, H-019 base/HEAD checks and H-020 safe-stop remain Harness
responsibilities. The worker service only executes the operation it receives.

## Provisioning and rollback scripts

The bounded source remediation is in the repair worktree, but neither script
has been run against the real host. The scripts remain test-boundary only and
fail closed before any OS mutation when a prerequisite is not proven.

- `scripts/provision-antigravity-worker.ps1` now uses marker schema v2 with a
  `provisioning_id`, worker SID, service binary path/hash, ownership flags,
  manifest path/hash, service-logon-right ownership fields and completed-step
  journal. Existing accounts/resources are not adopted; they return an
  unmanaged/partial-provisioning error. Parent ACLs and reparse paths are
  checked before mutation. `PasswordNeverExpires` is no longer forced; password
  rotation remains operator-managed and no plaintext is persisted.
- `scripts/unprovision-antigravity-worker.ps1` reads only the fixed marker
  under `CONTROL_ROOT`. Before deletion it verifies live SCM image path, binary
  hash, service identity, account SID, marker ownership, root ACL/reparse state
  and manifest hash. A caller-supplied service/account/path cannot authorize
  deletion by name alone. Missing or mismatched proof returns a structured
  error and performs no destructive cleanup.
- `scripts/lib/provisioning-safety.ps1` contains the shared path, ACL, hash,
  identity and ownership guards. `scripts/provisioning-safety.test.ps1` runs
  fixture-only negative checks without creating users, services or ACL changes.
- Neither script contains a password or copies credentials. Service
  registration currently fails with `SERVICE_LOGON_RIGHT_FAILED` because a
  reviewed SID/LSA provider and a reviewed native service binary are not yet
  available.

## Dry-run example (not executed with mutation)

```powershell
pwsh -NoProfile -File .\scripts\provision-antigravity-worker.ps1 -DryRun
pwsh -NoProfile -File .\scripts\unprovision-antigravity-worker.ps1 -DryRun -RemoveTestData
```

The first command reports user, roots, ACL classes, service registration,
firewall (`NONE`), Windows features (`NONE`) and credential handling. It does
not create anything. If the parent has broad write access, it returns
`ACL_BASELINE_UNSAFE` instead of claiming the child root is safe.

Both scripts require the immediate parent of every requested root to already
exist and have a trusted owner/ACL. They never create a missing parent or
change Windows permissions to make a dry-run pass. A default dry-run may
therefore stop with a structured safety error when `C:\ProgramData\QQ` or
another parent is missing/unsafe; that is an expected stop, not permission to
continue with real provisioning. Drive roots such as `C:\` are preserved as
roots during normalization so the result remains a valid Windows path.

Data removal is currently fail-closed. `-RemoveTestData` is rejected when the
worker account still exists and the Owner did not request account removal. It
also remains rejected until a reviewed provider can prove exclusive removal
conditions (worker stopped, no active handles, and an unchanged protected
tree). If that proof is unavailable or the tree changes after checking, the
script stops before deletion and keeps the marker. Account-only rollback does
not automatically remove test data.

## Self-test and acceptance criteria

The next phase needs a diagnostic run under the actual service identity:

1. source write: `ALLOWED`;
2. `ai-control.desired_state`: `DENIED`;
3. lifecycle state/claim/lease: `DENIED`;
4. review packet/checkpoint/completion receipt: `DENIED`;
5. audit/operations log: `DENIED`;
6. Harness source/config: `DENIED`;
7. task B from a task A assignment: `DENIED` when per-task ACL is enabled;
8. a child `node`, `python`, or `cmd` process inherits AIWorker and gets the
   same control-plane denial.

Any successful control write is `WORKER_ISOLATION_INVALID`. Missing service,
wrong identity, stale ACL proof, failed child test, unavailable AIWorker auth,
or failed IPC identity check returns `WORKER_ISOLATION_UNAVAILABLE` and the
Harness must not fall back to direct `agy`.

The safe source-level checks currently available are:

```powershell
pwsh -NoProfile -File .\scripts\provisioning-safety.test.ps1
node --test scripts/lib/harness-lifecycle.test.mjs
python -B mcp/test_antigravity_server.py
```

The provisioning safety fixture test passed 14 cases. The Harness lifecycle
test passed 43 cases. These are not OS-level proof.

## System changes that would occur later

| Class | Planned change | Current phase |
|---|---|---|
| local account | create non-admin `AIWorker` | not run |
| service | register manual-start native worker service | not run; binary missing |
| directories | create three isolated test roots | not run |
| ACL | replace inherited broad entries with explicit rules | not run |
| firewall | none | not run |
| Windows features | none | not run |
| credentials | SCM receives secure prompt; separate AIWorker auth | not run |
| production state | no migration/change | forbidden in this phase |

## Remaining uncertainties

- Antigravity's official noninteractive authentication path for a separate
  local account is not exposed by `agy --help` and has not been verified.
- The native SCM-aware worker service implementation and Named Pipe ACL/token
  check still need to be built and tested; no .NET SDK is installed locally.
- Windows effective permissions must be measured under AIWorker, including
  child processes; `icacls` output alone is insufficient.
- Gate A is ready for an independent source-level re-review; it is not a
  permission to provision.
- Gate C, Gate E, Gate F and Gate G remain open. H-021 is not closed. It can
  only be closed after separately approved OS-level work proves source allowed,
  control denied, child control denied, and Harness control allowed.
