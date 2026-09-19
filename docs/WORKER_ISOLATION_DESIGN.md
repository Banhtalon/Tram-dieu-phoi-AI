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

## First implementation slice — Windows worker service (design only)

This slice fixes the identity, process-order, contract, and framing decisions
before code. It creates no project, source file, SDK, account, service, ACL, or
Windows state.

### Service identity and pipe endpoint

- The existing provisioning name is QQAntigravityWorker-Test. Protocol version
  is 1. The per-provision pipe is
  \\.\pipe\QQAntigravityWorker-Test.v1.<provisioning_id>, where
  provisioning_id is the existing GUID in the verified marker. The broker never
  accepts a caller-supplied pipe name or instance id.
- The pipe name is an address, not a secret. The server must pass an explicit
  security descriptor to CreateNamedPipe; it must not rely on the default DACL,
  which Microsoft documents as granting access to Everyone and anonymous users.
  The DACL allows only the Harness/QQ identity, SYSTEM, and Administrators,
  explicitly denies NT AUTHORITY\NETWORK, and is local-only.
- Before sending any request, the broker opens the local SCM with only
  SC_MANAGER_CONNECT, then opens the exact service with only
  SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS. It verifies the marker's
  canonical binary path, SHA-256, AIWorker start account,
  SERVICE_WIN32_OWN_PROCESS type, and service SID configuration via
  QueryServiceConfig/QueryServiceConfig2. QueryServiceStatusEx with
  SC_STATUS_PROCESS_INFO must report RUNNING and gives the service PID. The
  first service version uses SERVICE_SID_TYPE_UNRESTRICTED so the expected
  NT SERVICE service SID is also available for token checking; that SID is an
  extra check, never the only one.
- The broker then connects only to the exact pipe and sends a 32-byte nonce
  generated with BCryptGenRandom; it contains no task data. Before accepting
  any task frame, the server reads only this challenge, calls
  ImpersonateNamedPipeClient on its server handle, opens the impersonation
  thread token with TOKEN_QUERY, and compares TokenUser with the expected
  Harness/QQ identity. It must check the impersonation return value, call
  RevertToSelf in a finally path, and close the connection if either step
  fails. GetNamedPipeClientProcessId is kept as a same-connection diagnostic;
  it is not the client-authentication proof by itself. Only after this check
  does the service return protocol version, service name, provisioning_id, its
  own PID, and an HMAC-SHA256 over those values plus the challenge.
- Provisioning must grant and self-test the broker only the four query rights
  needed for the verification chain: SERVICE_QUERY_CONFIG,
  SERVICE_QUERY_STATUS, PROCESS_QUERY_LIMITED_INFORMATION, and TOKEN_QUERY.
  It must not grant start, stop, change-configuration, or debug rights; any
  missing query right returns WORKER_ISOLATION_UNAVAILABLE rather than causing
  an elevation attempt.
- A per-provision pipe_auth_key is stored in a dedicated service-data file whose
  DACL grants only Harness/QQ and the service SID; generic AIWorker access to
  this file is not sufficient. The marker stores only the key-file path and
  hash, never the key. The broker verifies the HMAC, then compares the reported
  server PID with a fresh SCM PID and checks that process image/hash, TokenUser
  for AIWorker, and TokenGroups for the expected service SID using
  OpenProcessToken and GetTokenInformation. A pre-existing pipe cannot pass this
  proof. GetNamedPipeServerProcessId is retained only for server-side
  diagnostics because Microsoft specifies a CreateNamedPipe server handle; the
  broker does not call it on its client handle.
- Any challenge, HMAC, PID/path/hash/token, service-state, or handshake mismatch
  closes the handle and returns WORKER_ISOLATION_UNAVAILABLE before task data is
  sent. If the service restarts, the broker must establish a fresh
  SCM/PID/pipe/challenge check; it must not retry the operation automatically.

### Child-process order

1. Create the Job Object and set KILL_ON_JOB_CLOSE before creating agy. Do not
   allow either breakaway flag.
2. Duplicate the service's primary token and call CreateRestrictedToken: put
   the service SID in the deny-only list and remove unneeded privileges. A
   deny-only SID may remain in TokenGroups; the requirement is that it cannot
   grant access to the key file, not that the SID disappear. Create the child
   with CreateProcessAsUserW using this restricted primary token, the fixed
   machine-scoped agy path, the resolved task directory, the allowlisted
   Unicode environment, bounded stdio handles, and CREATE_SUSPENDED.
3. Pass only an explicit list of stdio handles. The key-file and pipe handles
   are non-inheritable and are never duplicated into agy or its descendants.
4. AssignProcessToJobObject while the primary thread is still suspended, then
   verify the child image and AIWorker token.
5. If any step fails, terminate the child if it exists, close its handles and
   the Job Object, and return a structured failure. Only after every check passes
   does the service call ResumeThread.
6. On timeout, output overflow, service stop, client disconnect, or write
   failure, terminate/close the Job Object, wait for the process tree, and
   return the existing timeout/output/error result. No child may remain running.

This order is required because Microsoft documents CREATE_SUSPENDED for a
process that must be assigned to a Job Object before it runs. Without a
breakaway flag, descendants created through CreateProcess remain in the Job
Object; KILL_ON_JOB_CLOSE terminates associated processes when the last handle
closes. References: [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
[GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid),
[GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid),
[ImpersonateNamedPipeClient](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient),
[Access Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens),
[OpenService](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-openservicew),
[QueryServiceConfig](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-queryserviceconfigw),
[QueryServiceStatusEx](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-queryservicestatusex),
[SERVICE_SID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info),
[CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken),
[CreateProcessAsUser](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw),
[OpenProcessToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken),
[BCryptGenRandom](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptgenrandom),
[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), and
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

### MCP contract, state, and framing

| Tool | Request kept compatible with the current source | Response and state rule |
|---|---|---|
| antigravity_execute | task_id, operation_id, prompt, invocation_kind=execute, attempt, rework_count | Returns the existing result fields, including task_id, workspace, status, error_code, timeout/output flags, operation correlation, conversation_id, timestamps, bounded output, and summary. |
| antigravity_continue | task_id, operation_id, instruction, invocation_kind=continue, attempt, rework_count; the service selects the in-memory conversation | Requires a new operation_id and an existing conversation; otherwise returns the current NO_CONVERSATION or correlation error. |
| antigravity_result | task_id only; it must not require execute/continue metadata | Returns RUNNING, the latest result, or NO_RESULT. workspace remains present even when operation metadata is null. |

For the supervised local trial, the broker parses the complete received stream before
bounding the stored evidence. A proven `view_file` step with `AbsolutePath` outside the
resolved absolute workspace (including relative, drive-relative, UNC, traversal or
reparse/junction paths) returns `WORKER_SCOPE_VIOLATION`. This check happens after the
worker run and therefore does not undo a read or claim to monitor every tool; the result
still retains timeout, exit, model, conversation and bounded evidence metadata. The
Harness treats this code as a non-retryable acceptance failure.

The state is keyed by task_id and exists only in one service process. The
service computes an internal SHA-256 digest over canonical UTF-8 JSON containing
only the immutable request fields: tool, task_id, operation_id,
invocation_kind, attempt, rework_count, and prompt/instruction. For continue,
the service captures the conversation id separately in the first accepted
operation record; it is not part of the digest. Under a per-task lock, the
service atomically records operation_id, request digest,
captured_conversation_id, and RUNNING before launching agy. The same
operation_id with the same digest returns RUNNING or the stored result without
launching a second agy. The same operation_id with a different digest returns
MCP_RESULT_CORRELATION_MISMATCH and does not launch. This digest check is a
required first-code change; the current fixture returns the old result for a
duplicate execute id without detecting a changed prompt.

The in-memory table is bounded at 64 operation records per service process and
does not evict records, so idempotency cannot silently turn into a second run.
When full, a new execute/continue returns MCP_OPERATION_STATE_LIMIT before
launch; existing result queries still work. After restart, the table is empty
and the service never replays an operation.

After a service restart, in-memory state is gone. antigravity_result(task_id)
returns NO_RESULT and the Harness maps that to recovery/CONVERSATION_LOST; the
service never re-runs the operation automatically. A continue without the
conversation also returns NO_CONVERSATION. The broker keeps the existing
stdio fixture path only for test_mode and never restores it as a production
fallback.

Each pipe connection carries one request and one response. Framing is a
4-byte little-endian unsigned byte length followed by one strict UTF-8 JSON
object; extra bytes, invalid UTF-8, invalid JSON, and forbidden fields are
rejected before dispatch. The limits are measured after JSON serialization:

- request frame: 512 KiB maximum; prompt/instruction remains at most 32,000
  characters;
- response frame: 32 MiB maximum, including JSON escaping, envelope metadata,
  stdout_events, stdout, stderr, and summary; each raw output stream remains
  capped at the current 4 MiB;
- header read: 5 seconds; request body read: 30 seconds; response write:
  30 seconds; agy execution: the existing 1–3,600 second range, default 300.

The receiver checks the length before allocation. If serialized output exceeds
the response-frame cap, it returns status OUTPUT_LIMIT, output_limited=true,
and error_code MCP_FRAME_TOO_LARGE rather than silently truncating or sending a
partial frame. A read/write timeout closes the pipe and stops the Job Object.

### Existing checks and the first code step

Existing fixture coverage includes path/workspace resolution, current
execute/continue/result and NO_RESULT-after-restart behavior,
stream-json/timeout/output handling, lifecycle correlation, and fail-closed
WORKER_ISOLATION_UNAVAILABLE. The missing checks are the SCM-to-pipe PID/path/
hash/service-SID chain (including name squatting and restart), real byte framing
and read/write timeouts, suspended-create/assign/resume ordering, real Job
Object tree termination, effective ACLs under AIWorker, and official
Antigravity authentication under that account.

The P2 serializer boundary check is only planned for the code stage: serialize
the largest Unicode/JSON-stream envelope at 32 MiB and one byte over the cap,
then require a bounded OUTPUT_LIMIT/MCP_FRAME_TOO_LARGE envelope with no
partial write or allocation based only on an untrusted length. No serializer
test is added in this documentation-only slice.

After separate Owner approval, the first code step is only the service
handshake/framing slice: add worker-service/QQAntigravityWorker.csproj and
worker-service/Program.cs, build a compiled SCM-aware binary, and do not launch
agy yet. The build criterion is a Release build with the .NET SDK matching the
installed runtime; the test criterion is rejection of malformed/oversized/
wrong-identity frames plus verified SCM PID = pipe PID = expected image/hash.
Only after this slice passes should the Job Object/agy execution slice be
started. The SDK is not installed now, and no source/provider/service/account/
ACL change is authorized by this document.

The remaining limits are explicit: the host has no .NET SDK, no reviewed worker
binary, no verified service logon-right provider, no real Named Pipe, no
AIWorker Antigravity authentication, and no Windows effective-permission or
safe-removal evidence. These design decisions therefore do not close H-021 or
any Windows gate.

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

Run the commands above to obtain the current source-level test results; the
counts are intentionally not duplicated here because they are evidence for a
specific run, not a permanent property of the design. Passing them is not
OS-level proof.

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
