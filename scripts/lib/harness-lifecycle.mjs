import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { access, mkdir, open, readFile, writeFile, rename, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { acquire, atomicJson, sourceAllowed } from './bridge.mjs';
import { git, readJson } from './workflow.mjs';
import { assertControlledContract } from './controlled-bridge.mjs';
import { runRedacted } from './redact.mjs';
import { invoke, validateBinding } from './bridge-adapters.mjs';
import { AntigravityMcpWorker, assertWorkerIsolation } from './implementation-worker.mjs';
import { ERROR_CODES, errorRecord, harnessError, operationId as stableOperationId } from './harness-errors.mjs';
import { auditEvent, auditSummary, operationEvent, transitionFields } from './harness-observability.mjs';

export const LIFECYCLE_SCHEMA = 'qq.workflow.lifecycle.v1';
export const CLAIM_SCHEMA = 'qq.workflow.claim.v1';
export const REVIEW_PACKET_SCHEMA = 'qq.workflow.review-packet.v1';
export const LIFECYCLE_STATES = Object.freeze({
  INITIALIZED: 'INITIALIZED',
  FROZEN: 'FROZEN',
  CLAIMED: 'CLAIMED',
  READY_TO_DISPATCH: 'READY_TO_DISPATCH',
  RUNNING: 'RUNNING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  REWORKING: 'REWORKING',
  WAITING_FOR_CHECKPOINT: 'WAITING_FOR_CHECKPOINT',
  CHECKPOINTED: 'CHECKPOINTED',
  COMPLETED: 'COMPLETED',
  PAUSED: 'PAUSED',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  CHECKPOINT_REJECTED: 'CHECKPOINT_REJECTED'
});
export const SAFE_STOP_STATES = Object.freeze([
  LIFECYCLE_STATES.BLOCKED,
  LIFECYCLE_STATES.FAILED,
  LIFECYCLE_STATES.RETRY_EXHAUSTED,
  LIFECYCLE_STATES.CHECKPOINT_REJECTED
]);
const SAFE_STOP_SET = new Set(SAFE_STOP_STATES);
export const RECONCILABLE_STATES = Object.freeze([
  LIFECYCLE_STATES.RUNNING,
  LIFECYCLE_STATES.RECOVERY_REQUIRED
]);
const RECONCILABLE_SET = new Set(RECONCILABLE_STATES);

const TASK_ID = /^TASK-[A-Z0-9_-]+$/i;
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_MAX_REWORK = 3;
const MAX_PACKET_TEXT = 256 * 1024;
const MAX_TEST_OUTPUT = 8 * 1024;
const MUTATION_LOCK_STALE_MS = 30_000;

function fail(code, message, details = {}) {
  const error = harnessError(code, message, {
    taskId: details.task_id ?? details.taskId ?? null,
    operation: details.operation ?? null,
    retryable: details.retryable,
    details
  });
  Object.assign(error, details);
  return error;
}

function isLeaseError(error) {
  return ['LEASE_MISSING', 'LEASE_EXPIRED', 'LEASE_OWNER_MISMATCH', 'LEASE_TOKEN_MISMATCH', 'LEASE_GENERATION_MISMATCH', 'ALREADY_CLAIMED'].includes(error?.code);
}

export { ERROR_CODES };

function text(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw fail('INVALID_INPUT', message);
  return value.trim();
}

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function createClock(now = Date.now) {
  if (typeof now !== 'function') throw fail('INVALID_INPUT', 'clock must be a function');
  return Object.freeze({ now, iso: () => nowIso(now) });
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function taskId(value) {
  const id = text(value, 'task_id is required');
  if (!TASK_ID.test(id)) throw fail('INVALID_TASK_ID', 'invalid task_id');
  return id;
}

function asPositiveInteger(value, fallback, name) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 1 || number > 3600) throw fail('INVALID_CONFIG', `${name} must be an integer between 1 and 3600`);
  return number;
}

function lifecycleConfig(config = {}) {
  const worker = config.worker;
  if (config.schema_version !== 'qq.bridge.v2') throw fail('CONFIG_MISMATCH', 'MCP lifecycle requires qq.bridge.v2 config');
  if (!worker || worker.transport !== 'mcp' || worker.server !== 'antigravity_worker') {
    throw fail('CONFIG_MISMATCH', 'active lifecycle requires the antigravity_worker MCP binding');
  }
  if (!Array.isArray(worker.command) || worker.command.length < 1 || worker.command.length > 2) throw fail('INVALID_CONFIG', 'MCP worker command must contain an executable and optional script');
  if (worker.skip_permissions === true && config.production === true) throw fail('INVALID_CONFIG', 'production MCP config must keep skip_permissions=false');
  if (config.auto_commit === true || config.auto_checkpoint === true) throw fail('INVALID_CONFIG', 'auto commit and auto checkpoint are disabled safe defaults');
  if (worker.provider !== undefined && worker.provider !== 'mcp') throw fail('CONFIG_MISMATCH', 'MCP worker provider must be mcp');
  const reviewer = config.reviewer;
  if (!reviewer) throw fail('CONFIG_MISMATCH', 'Codex reviewer binding is required');
  validateBinding(reviewer);
  if (reviewer.provider !== 'openai' || reviewer.cli !== 'codex') throw fail('CONFIG_MISMATCH', 'independent Codex reviewer binding is required');
  const lifecycle = config.lifecycle ?? {};
  const timeoutSeconds = asPositiveInteger(config.timeout_seconds, DEFAULT_LEASE_SECONDS, 'timeout_seconds');
  const maxRework = lifecycle.max_rework ?? DEFAULT_MAX_REWORK;
  if (!Number.isInteger(maxRework) || maxRework < 1 || maxRework > 3) throw fail('INVALID_CONFIG', 'lifecycle.max_rework must be between 1 and 3');
  if (typeof lifecycle.worktree_root !== 'undefined' && (typeof lifecycle.worktree_root !== 'string' || path.isAbsolute(lifecycle.worktree_root) || !isWithin('.', lifecycle.worktree_root))) throw fail('INVALID_CONFIG', 'lifecycle.worktree_root must be a relative path inside the project');
  if (typeof lifecycle.desired_state_path !== 'undefined' && typeof lifecycle.desired_state_path !== 'string') throw fail('INVALID_CONFIG', 'lifecycle.desired_state_path must be a path inside the project');
  return {
    ...config,
    timeout_seconds: timeoutSeconds,
    worker: { ...worker },
    reviewer: { ...reviewer },
    lifecycle: {
      ...lifecycle,
      lease_seconds: asPositiveInteger(lifecycle.lease_seconds, DEFAULT_LEASE_SECONDS, 'lifecycle.lease_seconds'),
      max_rework: maxRework,
      checkpoint_required: lifecycle.checkpoint_required !== false,
      auto_checkpoint: false,
      auto_commit: false,
      desired_state_path: lifecycle.desired_state_path ?? 'ai-control.desired_state',
      worktree_root: lifecycle.worktree_root ?? '.worktrees'
    }
  };
}

function repositoryRoot(start) {
  const cwd = path.resolve(start);
  let common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  if (!path.isAbsolute(common)) common = path.resolve(cwd, common);
  return path.dirname(common);
}

export function pathsFor(taskPath, packetDir, taskIdValue) {
  const task = path.resolve(taskPath);
  const id = taskId(taskIdValue);
  const requested = packetDir ? path.resolve(packetDir) : path.join(path.dirname(task), id);
  if (path.basename(requested).toLowerCase() !== id.toLowerCase()) {
    throw fail('PACKET_PATH_INVALID', 'lifecycle packet directory must be named after task_id');
  }
  return {
    taskPath: task,
    packetDir: requested,
    statePath: path.join(requested, 'state.json'),
    claimPath: task + '.claim.json',
    claimLockPath: task + '.claim.lock.json',
    reviewPacketPath: path.join(requested, 'review-packet.json'),
    workerResultPath: path.join(requested, 'worker-result.json'),
    auditPath: path.join(requested, 'audit.jsonl'),
    operationsPath: path.join(requested, 'operations.jsonl'),
    completionReceiptPath: path.join(requested, 'completion-receipt.json')
  };
}

async function loadTask(taskPath, operation = 'load-task') {
  try {
    return await readJson(taskPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('TASK_NOT_FOUND', `task packet does not exist: ${path.basename(taskPath)}`, { operation });
    if (error instanceof SyntaxError) throw fail('STATE_CORRUPTION', 'task packet is not valid JSON', { operation });
    throw error;
  }
}

async function optionalJson(file) {
  try { return await readJson(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw fail('STATE_CORRUPTION', `invalid JSON state file: ${path.basename(file)}`);
    throw error;
  }
}

async function atomicCreateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const fd = await open(file, 'wx');
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
}

async function atomicRawJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = await open(temporary, 'wx');
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temporary, file);
}

async function preserveCorruptEvidence(file, raw) {
  const evidence = `${file}.corrupt.${Date.now()}.json`;
  try {
    await writeFile(evidence, String(raw).slice(0, MAX_PACKET_TEXT), { flag: 'wx' });
    return evidence;
  } catch { return null; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function reclaimStaleMutationLock(lockPath) {
  let metadata = null;
  let stats;
  try {
    stats = await lstat(lockPath);
    const raw = await readFile(lockPath, 'utf8');
    metadata = JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
  }
  if (metadata?.pid && processIsAlive(metadata.pid)) return false;
  if (!metadata?.pid && (!stats || Date.now() - stats.mtimeMs < MUTATION_LOCK_STALE_MS)) return false;
  try { await unlink(lockPath); return true; }
  catch (error) { return error.code === 'ENOENT'; }
}

async function openTaskMutationLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = await open(lockPath, 'wx');
      await fd.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
      await fd.sync();
      return fd;
    } catch (error) {
      if (fd) {
        await fd.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      if (error.code !== 'EEXIST' || !(await reclaimStaleMutationLock(lockPath))) {
        if (error.code === 'EEXIST') throw fail('CLAIM_BUSY', 'task claim/state mutation is already in progress');
        throw error;
      }
    }
  }
  throw fail('CLAIM_BUSY', 'task claim/state mutation is already in progress');
}

// ponytail: one per-task lock serializes claim and state mutations; use finer locks only if throughput requires it.
export async function withTaskMutationLock(paths, action) {
  await mkdir(path.dirname(paths.claimLockPath), { recursive: true });
  const fd = await openTaskMutationLock(paths.claimLockPath);
  try { return await action(); }
  finally {
    try { await fd.close(); }
    finally {
      try { await unlink(paths.claimLockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function expired(claim, at = Date.now()) {
  const expires = Date.parse(claim?.lease_expires_at ?? '');
  return !Number.isFinite(expires) || expires <= at;
}

function validateClaim(claim, expectedTaskId) {
  const version = claim?.version ?? 1;
  if (!claim || claim.schema_version !== CLAIM_SCHEMA || claim.task_id !== expectedTaskId ||
      !text(claim.owner, 'claim owner is required') || !Number.isFinite(Date.parse(claim.claimed_at)) ||
      !Number.isFinite(Date.parse(claim.lease_expires_at)) || !text(claim.lease_token, 'lease token is required') ||
      !Number.isInteger(version) || version < 1) {
    throw fail('CLAIM_INVALID', 'claim state is invalid');
  }
  return claim;
}

function claimVersion(claim) {
  return claim?.version ?? 1;
}

function leaseFromClaim(claim) {
  return {
    owner: claim.owner,
    acquired_at: claim.claimed_at,
    expires_at: claim.lease_expires_at,
    renewed_at: claim.renewed_at ?? null,
    token: claim.lease_token,
    version: claimVersion(claim)
  };
}

function leaseSummary(claim) {
  const lease = leaseFromClaim(claim);
  delete lease.token;
  lease.token_present = true;
  return lease;
}

export { leaseSummary };

async function claimFromDisk(taskPath) {
  const task = await loadTask(taskPath, 'claim-read');
  const paths = pathsFor(taskPath, null, task.task_id);
  let saved;
  try { saved = await readJson(paths.claimPath); }
  catch (error) { if (error.code === 'ENOENT') throw fail('LEASE_MISSING', 'task lease is missing'); throw error; }
  return validateClaim(saved, task.task_id);
}

export async function claimTask(taskPath, { owner, leaseSeconds, now = Date.now } = {}) {
  const task = await loadTask(taskPath, 'claim');
  const id = taskId(task.task_id);
  const paths = pathsFor(taskPath, null, id);
  const claimant = text(owner ?? process.env.HARNESS_OWNER ?? `${os.hostname()}:${process.pid}`, 'claim owner is required');
  const seconds = asPositiveInteger(leaseSeconds, DEFAULT_LEASE_SECONDS, 'leaseSeconds');
  const claimedAt = now();
  const claim = {
    schema_version: CLAIM_SCHEMA,
    task_id: id,
    owner: claimant,
    claimed_at: new Date(claimedAt).toISOString(),
    lease_expires_at: new Date(claimedAt + seconds * 1000).toISOString(),
    renewed_at: null,
    lease_token: randomUUID(),
    version: 1
  };
  try {
    await atomicCreateJson(paths.claimPath, claim);
    await auditEvent(paths.packetDir, 'claim_acquired', { task_id: id, lease_owner: claimant, result: 'CLAIMED' });
    return { status: LIFECYCLE_STATES.CLAIMED, claim, lease: leaseFromClaim(claim) };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let current;
  try { current = validateClaim(await readJson(paths.claimPath), id); }
  catch (error) {
    if (error instanceof SyntaxError) throw fail('STATE_CORRUPTION', 'claim file is not valid JSON', { task_id: id, operation: 'claim' });
    throw error;
  }
  if (!expired(current, claimedAt)) {
    await auditEvent(paths.packetDir, 'claim_conflict', { task_id: id, lease_owner: claimant, result: 'ALREADY_CLAIMED', error_code: 'ALREADY_CLAIMED' });
    return { status: 'ALREADY_CLAIMED', claim: current, lease: leaseFromClaim(current), error: errorRecord(fail('ALREADY_CLAIMED', 'task is already claimed', { task_id: id }), { taskId: id }) };
  }
  return withTaskMutationLock(paths, async () => {
    let latest;
    try { latest = validateClaim(await readJson(paths.claimPath), id); }
    catch (error) {
      if (error instanceof SyntaxError) throw fail('STATE_CORRUPTION', 'claim file is not valid JSON', { task_id: id, operation: 'claim' });
      throw error;
    }
    if (!expired(latest, now())) {
      await auditEvent(paths.packetDir, 'claim_conflict', { task_id: id, lease_owner: claimant, result: 'ALREADY_CLAIMED', error_code: 'ALREADY_CLAIMED' });
      return { status: 'ALREADY_CLAIMED', claim: latest, lease: leaseFromClaim(latest), error: errorRecord(fail('ALREADY_CLAIMED', 'task is already claimed', { task_id: id }), { taskId: id }) };
    }
    const existingState = await optionalJson(paths.statePath);
    if (existingState && (existingState.phase === LIFECYCLE_STATES.RUNNING ||
      existingState.phase === LIFECYCLE_STATES.REWORKING ||
      existingState.in_flight)) {
      const recovery = fail('RECOVERY_REQUIRED', 'expired lease cannot be reclaimed while an external worker outcome is unresolved', {
        task_id: id,
        operation: existingState.in_flight?.id ?? null
      });
      return {
        status: LIFECYCLE_STATES.RECOVERY_REQUIRED,
        claim: latest,
        lease: leaseFromClaim(latest),
        error: errorRecord(recovery, { taskId: id, operation: existingState.in_flight?.id ?? null })
      };
    }
    const replacement = { ...claim, version: claimVersion(latest) + 1 };
    const temporary = paths.claimPath + '.' + randomUUID() + '.tmp';
    await atomicCreateJson(temporary, replacement);
    try { await unlink(paths.claimPath); await rename(temporary, paths.claimPath); }
    catch (replaceError) { try { await unlink(temporary); } catch {} throw replaceError; }
    await auditEvent(paths.packetDir, 'claim_reclaimed', { task_id: id, lease_owner: claimant, result: 'CLAIMED' });
    return { status: LIFECYCLE_STATES.CLAIMED, claim: replacement, lease: leaseFromClaim(replacement), reclaimed: true };
  });
}

export async function validateLease(taskPath, { owner, token, version, now = Date.now } = {}) {
  const task = await loadTask(taskPath, 'lease-validate');
  const id = taskId(task.task_id);
  const paths = pathsFor(taskPath, null, id);
  let saved;
  try { saved = await readJson(paths.claimPath); }
  catch (error) { if (error.code === 'ENOENT') throw fail('LEASE_MISSING', 'task lease is missing'); throw error; }
  const claim = validateClaim(saved, id);
  if (claim.owner !== text(owner, 'lease owner is required')) throw fail('LEASE_OWNER_MISMATCH', 'lease belongs to another owner');
  if (claim.lease_token !== text(token, 'lease token is required')) throw fail('LEASE_TOKEN_MISMATCH', 'lease token is stale');
  if (version !== undefined && claim.version !== version) throw fail('LEASE_GENERATION_MISMATCH', 'lease generation is stale');
  if (expired(claim, now())) throw fail('LEASE_EXPIRED', 'lease has expired');
  return { claim, lease: leaseFromClaim(claim) };
}

export async function renewLease(taskPath, { owner, token, version, leaseSeconds, now = Date.now } = {}) {
  const task = await loadTask(taskPath, 'lease-renew');
  const paths = pathsFor(taskPath, null, task.task_id);
  return withTaskMutationLock(paths, async () => {
    const current = await validateLease(taskPath, { owner, token, version, now });
    const seconds = asPositiveInteger(leaseSeconds, DEFAULT_LEASE_SECONDS, 'leaseSeconds');
    const at = now();
    const next = {
      ...current.claim,
      renewed_at: new Date(at).toISOString(),
      lease_expires_at: new Date(at + seconds * 1000).toISOString(),
      // The generation fences ownership changes. Renewal extends time only.
      version: claimVersion(current.claim)
    };
    await atomicRawJson(paths.claimPath, next);
    await auditEvent(paths.packetDir, 'lease_renewed', { task_id: task.task_id, lease_owner: next.owner, result: 'LEASE_RENEWED' });
    return { status: 'LEASE_RENEWED', claim: next, lease: leaseFromClaim(next) };
  });
}

export async function releaseLease(taskPath, { owner, token, version, now = Date.now } = {}) {
  const task = await loadTask(taskPath, 'lease-release');
  const paths = pathsFor(taskPath, null, task.task_id);
  return withTaskMutationLock(paths, async () => {
    const current = await validateLease(taskPath, { owner, token, version, now });
    await unlink(paths.claimPath);
    await auditEvent(paths.packetDir, 'lease_released', { task_id: task.task_id, lease_owner: current.claim.owner, result: 'LEASE_RELEASED' });
    return { status: 'LEASE_RELEASED', claim: current.claim };
  });
}

export function resolveDesiredStatePath(repoRoot, config = {}) {
  const root = path.resolve(repoRoot);
  const configured = config.lifecycle?.desired_state_path ?? 'ai-control.desired_state';
  const candidate = path.resolve(root, configured);
  if (!isWithin(root, candidate)) throw fail('CONTROL_PATH_INVALID', 'desired_state_path must stay inside the project root');
  return candidate;
}

export async function readDesiredState(repoRoot, config = {}) {
  const file = resolveDesiredStatePath(repoRoot, config);
  let raw;
  try { raw = (await readFile(file, 'utf8')).trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'stopped', exists: false, path: file, reason: 'control file is missing; fail closed' };
    throw error;
  }
  let value = raw.toLowerCase();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') value = parsed.trim().toLowerCase();
    else if (parsed && typeof parsed.desired_state === 'string') value = parsed.desired_state.trim().toLowerCase();
  } catch {}
  if (!['running', 'paused', 'stopped'].includes(value)) return { state: 'stopped', exists: true, path: file, reason: 'invalid desired state; fail closed' };
  return { state: value, exists: true, path: file };
}

export function assertDispatchAllowed(control) {
  if (control?.state !== 'running') throw fail('DESIRED_STATE_BLOCKED', `desired_state=${control?.state ?? 'unknown'} does not allow dispatch`);
  return control;
}

function configuredWorktreeRoot(repoRoot, config = {}) {
  const root = path.resolve(repoRoot);
  const configured = config.lifecycle?.worktree_root ?? '.worktrees';
  const candidate = path.resolve(root, configured);
  if (!isWithin(root, candidate)) throw fail('WORKTREE_ROOT_INVALID', 'worktree root must stay inside the project root');
  return candidate;
}

async function canonicalDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('WORKTREE_INVALID', `${label} must be a real directory`);
  const canonical = await realpath(directory);
  return canonical;
}

export async function resolveTaskWorktree(taskIdValue, { task, taskPath, repoRoot, config = {}, create = true } = {}) {
  const id = taskId(taskIdValue);
  const sourceRoot = path.resolve(repoRoot ?? repositoryRoot(path.dirname(taskPath)));
  const canonicalSourceRoot = await realpath(sourceRoot);
  const worktreeRoot = configuredWorktreeRoot(sourceRoot, config);
  if (!existsSync(worktreeRoot) && !create) throw fail('WORKTREE_NOT_FOUND', 'configured WORKTREE_ROOT does not exist');
  await mkdir(worktreeRoot, { recursive: true });
  const canonicalRoot = await canonicalDirectory(worktreeRoot, 'WORKTREE_ROOT');
  if (!isWithin(canonicalSourceRoot, canonicalRoot)) throw fail('WORKTREE_ROOT_INVALID', 'worktree root resolves outside the project root');
  const candidate = path.resolve(canonicalRoot, id);
  if (!isWithin(canonicalRoot, candidate) || path.basename(candidate).toLowerCase() !== id.toLowerCase()) {
    throw fail('WORKTREE_ESCAPE', 'task worktree escapes WORKTREE_ROOT');
  }
  let created = false;
  const frozenTask = task ?? (taskPath ? await loadTask(taskPath, 'worktree-resolve') : null);
  const base = frozenTask?.base_sha;
  if (!/^[0-9a-f]{40}$/i.test(base ?? '')) throw fail('WORKTREE_BASE_INVALID', 'task base_sha is required to resolve a worktree', { task_id: id });
  if (!existsSync(candidate)) {
    if (!create) throw fail('WORKTREE_NOT_FOUND', 'task worktree does not exist');
    git(sourceRoot, 'worktree', 'add', '--detach', candidate, base);
    created = true;
  }
  const canonicalCandidate = await canonicalDirectory(candidate, 'task worktree');
  if (!isWithin(canonicalRoot, canonicalCandidate) || canonicalCandidate.toLowerCase() === canonicalSourceRoot.toLowerCase()) throw fail('WORKTREE_ESCAPE', 'task worktree resolves outside WORKTREE_ROOT or is the source repository');
  let gitRoot;
  try { gitRoot = path.resolve(git(canonicalCandidate, 'rev-parse', '--show-toplevel').trim()); }
  catch (error) { throw fail('WORKTREE_NOT_FOUND', `task worktree is not a Git worktree: ${error.message}`); }
  if (gitRoot.toLowerCase() !== canonicalCandidate.toLowerCase()) throw fail('WORKTREE_ESCAPE', 'resolved directory is not the task Git worktree');
  if (existsSync(path.join(canonicalCandidate, '.git', 'config'))) throw fail('WORKTREE_ESCAPE', 'task worktree cannot contain a nested repository root');
  const head = git(canonicalCandidate, 'rev-parse', 'HEAD').trim();
  if (head.toLowerCase() !== base.toLowerCase()) {
    throw fail('WORKTREE_BASE_MISMATCH', 'task worktree HEAD does not match the frozen task base_sha', {
      task_id: id,
      expected_base_sha: base,
      actual_head: head
    });
  }
  let sourceCommon = path.resolve(git(sourceRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  let worktreeCommon = path.resolve(git(canonicalCandidate, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  if (sourceCommon.toLowerCase() !== worktreeCommon.toLowerCase()) {
    throw fail('WORKTREE_REPOSITORY_MISMATCH', 'task worktree belongs to a different Git repository', { task_id: id });
  }
  return { repoRoot: sourceRoot, worktreeRoot: canonicalRoot, workspace: canonicalCandidate, created };
}

function parseStatus(output) {
  const tokens = output ? output.split('\0').filter(Boolean) : [];
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    const xy = item.slice(0, 2);
    const firstPath = item.slice(3).replace(/\\/g, '/');
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const newPath = (tokens[index + 1] ?? '').replace(/\\/g, '/');
      index += 1;
      files.push({ path: newPath, old_path: firstPath, status: 'renamed', git_status: xy });
      continue;
    }
    const status = xy.includes('D') ? 'deleted' : xy === '??' ? 'untracked' : xy.includes('A') ? 'added' : 'modified';
    files.push({ path: firstPath, status, git_status: xy });
  }
  return files;
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) &&
    !value.split('/').some(part => part === '..' || part === '.' || part === '') && !/[\x00-\x1f:*?\[\]\\]/.test(value);
}

export function collectChangeset(cwd, allowedPaths = []) {
  const output = git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const files = parseStatus(output);
  const allowed = new Set(allowedPaths.map(value => value.replace(/\\/g, '/')));
  for (const file of files) {
    if (!safePath(file.path) || !allowed.has(file.path) || (file.old_path && (!safePath(file.old_path) || !allowed.has(file.old_path)))) {
      throw fail('SCOPE_VIOLATION', `changed file is outside the frozen scope: ${file.path}`);
    }
  }
  return files;
}

function changeSignature(files, diff) {
  return hash({ files, diff });
}

async function fileContents(cwd, files) {
  return Promise.all(files.map(async file => {
    if (file.status === 'deleted') return { ...file, content: null };
    const full = path.join(cwd, file.path);
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACKET_TEXT) throw fail('CONTENT_MISMATCH', `changed file is not a bounded regular file: ${file.path}`);
    const content = await readFile(full, 'utf8');
    if (!sourceAllowed(file.path, content, { synthetic_source_approvals: [] })) throw fail('CONTENT_MISMATCH', `changed file contains binary or secret-like content: ${file.path}`);
    return { ...file, size: info.size, sha256: hash(content), content };
  }));
}

export async function buildChangesetPacket(cwd, task, tests, previousSignature = null) {
  const files = collectChangeset(cwd, task.allowed_paths ?? task.write_paths ?? []);
  const diff = git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--unified=3', 'HEAD', '--', ...files.map(file => file.path));
  const content = await fileContents(cwd, files);
  const signature = changeSignature(content.map(({ content: ignored, ...file }) => file), diff + content.map(file => file.content ?? '').join('\n'));
  if (previousSignature && previousSignature === signature) throw fail('NOOP_REWORK', 'rework did not produce a new changeset');
  return { changed_files: content, diff, signature };
}

async function snapshotProtected(paths) {
  const snapshot = {};
  for (const file of paths) {
    try { snapshot[file] = hash(await readFile(file)); }
    catch (error) { if (error.code === 'ENOENT') snapshot[file] = null; else throw error; }
  }
  return snapshot;
}

function protectedControlPaths(paths) {
  return [
    paths.taskPath,
    paths.taskPath + '.lock.json',
    paths.claimPath,
    paths.statePath,
    paths.reviewPacketPath,
    paths.workerResultPath,
    paths.auditPath,
    paths.operationsPath,
    paths.completionReceiptPath
  ];
}

async function assertProtectedUnchanged(snapshot) {
  for (const [file, expected] of Object.entries(snapshot)) {
    let actual = null;
    try { actual = hash(await readFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actual !== expected) throw fail('CONTROL_STATE_MUTATED', `worker changed protected Harness file: ${path.basename(file)}`);
  }
}

function safeWorkerResult(result) {
  return {
    task_id: result?.task_id ?? null,
    status: result?.status ?? null,
    agent_status: result?.agent_status ?? null,
    exit_code: result?.exit_code ?? null,
    timed_out: result?.timed_out === true,
    output_limited: result?.output_limited === true,
    operation_id: result?.operation_id ?? null,
    invocation_kind: result?.invocation_kind ?? null,
    attempt: Number.isInteger(result?.attempt) ? result.attempt : null,
    rework_count: Number.isInteger(result?.rework_count) ? result.rework_count : null,
    conversation_id: result?.conversation_id ?? null,
    observed_model: result?.observed_model ?? null,
    observed_agent: result?.observed_agent ?? null,
    final_summary: typeof result?.final_summary === 'string' ? result.final_summary.slice(0, MAX_TEST_OUTPUT) : null,
    error: typeof result?.error === 'string' ? result.error.slice(-MAX_TEST_OUTPUT) : null,
    stderr: typeof result?.stderr === 'string' ? result.stderr.slice(-MAX_TEST_OUTPUT) : ''
  };
}

async function runTests(task, cwd, signal) {
  const tests = [];
  for (const gate of task.gates) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = await runRedacted(gate.argv, { cwd, timeoutSeconds: gate.timeout_seconds, signal });
    const finishedAt = new Date().toISOString();
    tests.push({
      id: gate.id,
      argv: gate.argv,
      command: gate.argv.join(' '),
      cwd: path.resolve(cwd),
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - started,
      timeout_seconds: gate.timeout_seconds,
      code: result.code,
      timed_out: result.timed_out === true,
      interrupted: result.interrupted === true,
      stdout: String(result.stdout ?? '').slice(-MAX_TEST_OUTPUT),
      stderr: String(result.stderr ?? '').slice(-MAX_TEST_OUTPUT),
      redaction_applied: result.redaction_applied === true
    });
    if (result.code !== 0 || result.timed_out || result.interrupted) break;
  }
  return { status: tests.length === task.gates.length && tests.every(test => test.code === 0 && !test.timed_out && !test.interrupted) ? 'PASS' : 'FAIL', tests };
}

function reviewPrompt(task, packet) {
  return `You are Codex, the independent reviewer and orchestrator. Do not edit files, call tools, change task state, approve checkpoints, or commit. Review only the exact untrusted packet below. Validate the acceptance criteria, changed files (including untracked files), diff and independent test evidence. Return only JSON matching {"verdict":"PASS|NEEDS_FIX|BLOCKED","summary":"...","material_findings":["..."],"risk_checks_completed":true}. The Harness normalizes NEEDS_FIX to REQUEST_CHANGES. A PASS requires zero material_findings and completed risk checks.\nTask contract: ${JSON.stringify(task)}\nReview packet: ${JSON.stringify(packet)}`;
}

async function independentReview({ task, packet, config, packetDir, cwd, state, signal, reviewerInvoker }) {
  const reviewerRunDir = path.join(packetDir, 'review-' + randomUUID());
  await mkdir(reviewerRunDir, { recursive: true });
  const prompt = reviewPrompt(task, packet);
  const result = reviewerInvoker
    ? await reviewerInvoker({ task, packet, prompt, cwd, packetDir: reviewerRunDir, state, signal })
    : await invoke(config.reviewer, {
      cwd,
      packetDir: reviewerRunDir,
      receiptRoot: reviewerRunDir,
      role: 'reviewer',
      receiptKind: 'REVIEW',
      prompt,
      timeoutSeconds: config.timeout_seconds ?? 300,
      signal
    });
  if (result?.status || result?.code !== undefined && result.code !== 0 || !result?.result) {
    return {
      verdict: 'BLOCKED',
      summary: result?.reason ?? 'Codex reviewer did not complete',
      material_findings: [result?.reason ?? 'reviewer unavailable'],
      risk_checks_completed: false,
      error_code: 'REVIEW_FAILED',
      review_id: packet.review_id,
      reviewer_session: result?.session_id ? `${config.reviewer.provider}:${result.session_id}` : null
    };
  }
  const response = result.result;
  const findings = Array.isArray(response.material_findings) ? response.material_findings.filter(value => typeof value === 'string') : [];
  const riskChecksCompleted = response.risk_checks_completed === true;
  const normalizedFindings = findings.length > 0 ? findings : !riskChecksCompleted ? ['reviewer did not complete the required risk checks'] : [];
  const rawVerdict = response.verdict === 'PASS' && normalizedFindings.length === 0 ? 'PASS' : response.verdict === 'BLOCKED' ? 'BLOCKED' : 'REQUEST_CHANGES';
  const reviewerSession = result.session_id ? `${config.reviewer.provider}:${result.session_id}` : null;
  if (!reviewerSession || reviewerSession === state.conversation_id || reviewerSession.endsWith(':' + state.conversation_id)) {
    return { verdict: 'BLOCKED', summary: 'reviewer session is not independent', material_findings: ['reviewer session is not independent'], risk_checks_completed: false, error_code: 'REVIEW_FAILED', review_id: packet.review_id, reviewer_session: reviewerSession };
  }
  return {
    verdict: rawVerdict,
    review_id: packet.review_id,
    summary: String(response.summary ?? '').slice(0, MAX_TEST_OUTPUT),
    material_findings: normalizedFindings,
    risk_checks_completed: riskChecksCompleted,
    reviewer_session: reviewerSession,
    observed_models: result.observed_models ?? []
  };
}

function initialState(task, paths, claim, worktree, control, config) {
  const at = new Date().toISOString();
  return {
    schema_version: LIFECYCLE_SCHEMA,
    task_id: task.task_id,
    revision: task.revision,
    contract_sha256: task.contract_sha256,
    task_path: paths.taskPath,
    packet_dir: paths.packetDir,
    run_id: randomUUID(),
    repo_root: worktree.repoRoot,
    worktree_root: worktree.worktreeRoot,
    workspace: worktree.workspace,
    phase: LIFECYCLE_STATES.CLAIMED,
    status: LIFECYCLE_STATES.CLAIMED,
    owner: claim.owner,
    lease: leaseSummary(claim),
    attempt: 0,
    rework_count: 0,
    max_rework: config.lifecycle.max_rework,
    worker: 'antigravity',
    conversation_id: null,
    latest_execution: null,
    changed_files: [],
    changeset_signature: null,
    tests: [],
    review_result: null,
    review_id: null,
    requested_changes: [],
    request_history: [],
    checkpoint: { required: config.lifecycle.checkpoint_required, approved: false, approved_by: null, approved_at: null, checkpoint_id: null, review_id: null, changeset_signature: null },
    completion: null,
    recovery: null,
    baseline_changeset_signature: null,
    in_flight: null,
    error: null,
    last_error: null,
    desired_state: control.state,
    desired_state_path: control.path,
    state_revision: 0,
    created_at: at,
    updated_at: at,
    history: []
  };
}

function terminal(state) {
  return state?.status === LIFECYCLE_STATES.COMPLETED || state?.phase === LIFECYCLE_STATES.COMPLETED;
}

function resultOf(state) {
  return { ...state, terminal: terminal(state), error: state.error ?? state.last_error ?? null };
}

function safeStopResult(state, taskIdValue) {
  const error = fail('INVALID_TRANSITION', `normal run is stopped at ${state.phase}; explicit owner retry/replan is required`, {
    task_id: taskIdValue,
    safe_stop: true,
    operator_action_required: true
  });
  return { ...resultOf(state), error: errorRecord(error, { taskId: taskIdValue }) };
}

async function assertMutationFence(paths, fence) {
  if (!fence || typeof fence !== 'object') throw fail('LEASE_TOKEN_MISMATCH', 'state mutation requires a lease fence');
  const expectedOwner = text(fence.owner, 'lease owner is required');
  const expectedToken = text(fence.lease_token ?? fence.token, 'lease token is required');
  let saved;
  try { saved = await readJson(paths.claimPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw fail('LEASE_MISSING', 'task lease is missing');
    throw error;
  }
  const claim = validateClaim(saved, path.basename(paths.taskPath, '.json'));
  if (claim.owner !== expectedOwner) throw fail('LEASE_OWNER_MISMATCH', 'lease belongs to another owner');
  if (claim.lease_token !== expectedToken) throw fail('LEASE_TOKEN_MISMATCH', 'lease token is stale');
  if (fence.version !== undefined && claimVersion(claim) !== fence.version) throw fail('LEASE_GENERATION_MISMATCH', 'lease generation is stale');
  if (expired(claim)) throw fail('LEASE_EXPIRED', 'lease has expired');
  return claim;
}

async function canonicalStateForMutation(paths) {
  const current = await optionalJson(paths.statePath);
  if (!current) return null;
  try { return validateLifecycleState(current); }
  catch (error) { throw fail('STATE_CORRUPTION', error.message, { task_id: current?.task_id ?? null }); }
}

async function withFencedTaskMutation(paths, fence, action) {
  return withTaskMutationLock(paths, async () => {
    const currentClaim = await assertMutationFence(paths, fence);
    return action(currentClaim);
  });
}

async function writeFencedJson(paths, file, value, fence, expectedStateRevision) {
  return withFencedTaskMutation(paths, fence, async () => {
    if (expectedStateRevision !== undefined) {
      const canonical = await canonicalStateForMutation(paths);
      const actualStateRevision = canonical && Number.isInteger(canonical.state_revision) ? canonical.state_revision : 0;
      if (actualStateRevision !== expectedStateRevision) {
        throw fail('IDEMPOTENCY_CONFLICT', 'lifecycle state revision is stale before artifact write', {
          expected_state_revision: expectedStateRevision,
          actual_state_revision: actualStateRevision
        });
      }
    }
    return atomicJson(file, value);
  });
}

export async function saveState(state, paths, patch = {}, fence) {
  return withFencedTaskMutation(paths, fence, async currentClaim => {
    const canonical = await canonicalStateForMutation(paths);
    if (canonical && canonical.task_id !== state.task_id) throw fail('STATE_MISMATCH', 'lifecycle state does not match the requested task');
    const expectedRevision = Number.isInteger(state.state_revision) ? state.state_revision : 0;
    const actualRevision = canonical && Number.isInteger(canonical.state_revision) ? canonical.state_revision : 0;
    if ((canonical && actualRevision !== expectedRevision) || (!canonical && expectedRevision !== 0)) {
      throw fail('IDEMPOTENCY_CONFLICT', 'lifecycle state revision is stale', {
        task_id: state.task_id,
        expected_state_revision: expectedRevision,
        actual_state_revision: actualRevision
      });
    }
    const previousPhase = state.phase;
    const previousStatus = state.status;
    const previousDesiredState = state.desired_state;
    if (!Object.prototype.hasOwnProperty.call(patch, 'error')) {
      state.error = null;
      state.last_error = null;
    } else {
      const normalized = patch.error ? errorRecord(typeof patch.error === 'string' ? fail('INTERNAL_ERROR', patch.error, { task_id: state.task_id }) : patch.error, { taskId: state.task_id }) : null;
      patch = { ...patch, error: normalized, last_error: normalized };
    }
    Object.assign(state, patch, { updated_at: new Date().toISOString(), state_revision: expectedRevision + 1 });
    validateLifecycleState(state);
    if (previousPhase !== state.phase || previousStatus !== state.status) {
      await auditEvent(paths.packetDir, 'state_transition', transitionFields(state, {
        previous_state: previousPhase,
        next_state: state.phase,
        result: state.status,
        error_code: state.error?.code ?? null
      }));
    }
    if (previousDesiredState !== undefined && previousDesiredState !== state.desired_state) {
      await auditEvent(paths.packetDir, 'desired_state_observed', transitionFields(state, { result: state.desired_state }));
    }
    await atomicJson(paths.statePath, state);
    return { state, claim: currentClaim };
  }).then(result => result.state);
}

function ownerOf(options, state, config) {
  return options.owner ?? config.owner ?? process.env.HARNESS_OWNER ?? state?.owner ?? `${os.hostname()}:${process.pid}`;
}

async function stateFor(paths) {
  let raw;
  try { raw = await readFile(paths.statePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let state;
  try { state = JSON.parse(raw); }
  catch (error) {
    const evidence = await preserveCorruptEvidence(paths.statePath, raw);
    throw fail('STATE_CORRUPTION', 'lifecycle state is not valid JSON', { task_id: null, details: { evidence } });
  }
  try { validateLifecycleState(state); }
  catch (error) {
    const evidence = await preserveCorruptEvidence(paths.statePath, raw);
    throw fail('STATE_CORRUPTION', error.message, { details: { evidence } });
  }
  if (state.state_revision === undefined) state.state_revision = 0;
  return state;
}

function validateLifecycleState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail('INVALID_TASK_STATE', 'lifecycle state must be an object');
  if (state.schema_version !== LIFECYCLE_SCHEMA) throw fail('STATE_CORRUPTION', `unsupported lifecycle state schema: ${state.schema_version}`);
  if (!TASK_ID.test(String(state.task_id ?? ''))) throw fail('INVALID_TASK_STATE', 'lifecycle state task_id is invalid');
  if (!Object.values(LIFECYCLE_STATES).includes(state.phase) || state.status !== state.phase && !(state.phase === LIFECYCLE_STATES.REWORKING && state.status === LIFECYCLE_STATES.REQUEST_CHANGES)) {
    throw fail('INVALID_TASK_STATE', 'lifecycle state contains an unknown phase/status');
  }
  if (!Number.isInteger(state.attempt) || state.attempt < 0 || !Number.isInteger(state.rework_count) || state.rework_count < 0) {
    throw fail('INVALID_TASK_STATE', 'lifecycle counters are invalid');
  }
  if (state.state_revision !== undefined && (!Number.isInteger(state.state_revision) || state.state_revision < 0)) {
    throw fail('INVALID_TASK_STATE', 'lifecycle state_revision is invalid');
  }
  if (!Array.isArray(state.history) || !Array.isArray(state.tests) || !Array.isArray(state.requested_changes)) {
    throw fail('INVALID_TASK_STATE', 'lifecycle collections are invalid');
  }
  return state;
}

async function ensureClaim(taskPath, paths, state, owner, config) {
  if (state?.lease) {
    try {
      const saved = await claimFromDisk(taskPath);
      return (await validateLease(taskPath, { owner, token: saved.lease_token })).claim;
    } catch (error) {
      if (!['LEASE_MISSING', 'CLAIM_INVALID', 'LEASE_EXPIRED'].includes(error.code)) throw error;
    }
  }
  const claimed = await claimTask(taskPath, { owner, leaseSeconds: config.lifecycle.lease_seconds });
  if (claimed.status === 'ALREADY_CLAIMED') throw fail('ALREADY_CLAIMED', 'task is already claimed', { claim: claimed.claim });
  if (claimed.status === LIFECYCLE_STATES.RECOVERY_REQUIRED) throw fail('RECOVERY_REQUIRED', 'expired lease cannot be reclaimed while an external worker outcome is unresolved', { task_id: state?.task_id ?? null, operation: state?.in_flight?.id ?? null });
  return claimed.claim;
}

async function checkStateIdentity(task, state) {
  if (state.task_id !== task.task_id || state.revision !== task.revision || state.contract_sha256 !== task.contract_sha256) {
    throw fail('STATE_MISMATCH', 'lifecycle state does not match frozen task');
  }
}

function mcpWorkerFor(options, config, worktree) {
  if (options.worker) return options.worker;
  const key = `${worktree.repoRoot}:${worktree.workspace}:${config.worker.server}`;
  let worker = WORKERS.get(key);
  if (!worker) {
    worker = new AntigravityMcpWorker({
      repoRoot: worktree.repoRoot,
      worktreeRoot: worktree.worktreeRoot,
      config,
      timeoutSeconds: config.timeout_seconds ?? 300
    });
    WORKERS.set(key, worker);
  }
  return worker;
}

const WORKERS = new Map();

async function releaseWorker(options, worker, worktree) {
  if (options.worker) return;
  const key = `${worktree.repoRoot}:${worktree.workspace}:${options.config.worker.server}`;
  await worker.close();
  WORKERS.delete(key);
}

function workerError(result, taskIdValue, operation) {
  const base = { task_id: taskIdValue, operation };
  if (result?.status === 'NO_RESULT' || result?.error_code === 'NO_RESULT') return fail('CONVERSATION_LOST', 'MCP result has no persisted conversation after worker restart', base);
  if (result?.timed_out === true || result?.status === 'TIMED_OUT') return fail('WORKER_TIMEOUT', 'implementation worker timed out', base);
  if (result?.output_limited === true || result?.status === 'OUTPUT_LIMIT') return fail('WORKER_OUTPUT_LIMIT', 'implementation worker output exceeded the configured limit', base);
  if (result?.status === 'UNAVAILABLE') return fail('WORKER_UNAVAILABLE', 'implementation worker is unavailable', base);
  return fail('WORKER_EXECUTION_FAILED', String(result?.error ?? result?.stderr ?? 'implementation worker failed'), base);
}

function operationValid(operation, task) {
  if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string' ||
      !['execute', 'continue'].includes(operation.kind) ||
      !Number.isInteger(operation.attempt) || operation.attempt < 1 ||
      !Number.isInteger(operation.rework_count) || operation.rework_count < 0) return false;
  const expected = stableOperationId(task.task_id, operation.kind, operation.attempt, operation.rework_count, task.contract_sha256);
  return operation.id === expected && (!operation.idempotency_key || operation.idempotency_key === operation.id);
}

function resultCorrelationError(task, result, operation, expectedConversation = null) {
  const expected = {
    task_id: task.task_id,
    operation_id: operation.id,
    invocation_kind: operation.kind,
    attempt: operation.attempt,
    rework_count: operation.rework_count,
    conversation_id: expectedConversation
  };
  const actual = {
    task_id: result?.task_id ?? null,
    operation_id: result?.operation_id ?? null,
    invocation_kind: result?.invocation_kind ?? null,
    attempt: result?.attempt ?? null,
    rework_count: result?.rework_count ?? null,
    conversation_id: result?.conversation_id ?? null
  };
  const mismatch = actual.task_id !== expected.task_id || actual.operation_id !== expected.operation_id ||
    actual.invocation_kind !== expected.invocation_kind || actual.attempt !== expected.attempt ||
    actual.rework_count !== expected.rework_count ||
    (expected.conversation_id !== null && actual.conversation_id !== expected.conversation_id);
  return mismatch ? fail('MCP_RESULT_CORRELATION_MISMATCH', 'MCP result does not belong to the in-flight operation', {
    task_id: task.task_id,
    operation: operation.id,
    expected,
    actual
  }) : null;
}

async function persistRecovery(state, paths, claim, error, reason, operation) {
  await saveState(state, paths, {
    phase: LIFECYCLE_STATES.RECOVERY_REQUIRED,
    status: LIFECYCLE_STATES.RECOVERY_REQUIRED,
    in_flight: operation ?? state.in_flight ?? null,
    recovery: {
      ...(state.recovery ?? {}),
      required: true,
      reason,
      operation_id: operation?.id ?? state.in_flight?.id ?? null
    },
    error
  }, claim);
  return resultOf(state);
}

async function assertInitialWorktreeClean(task, workspace) {
  let files;
  try { files = collectChangeset(workspace, task.allowed_paths ?? task.write_paths ?? []); }
  catch (error) {
    if (error.code === 'SCOPE_VIOLATION') throw fail('WORKTREE_DIRTY', 'task worktree contains changes outside the frozen scope before the first dispatch', { task_id: task.task_id });
    throw error;
  }
  if (files.length > 0) throw fail('WORKTREE_DIRTY', 'task worktree contains changes before the first dispatch', { task_id: task.task_id, details: { files: files.map(file => file.path) } });
}

function reviewIdFor(task, attempt, rework) {
  return `review-${hash(`${task.task_id}:${task.contract_sha256}:${attempt}:${rework}`).slice(0, 32)}`;
}

function requestFor(review, state, instruction) {
  const id = `request-${hash(`${review.review_id ?? state.review_id}:${state.rework_count + 1}:${instruction}`).slice(0, 32)}`;
  return {
    id,
    review_id: review.review_id ?? state.review_id,
    instruction,
    created_at: new Date().toISOString(),
    source: 'codex-orchestrator',
    source_changeset_signature: state.changeset_signature,
    target_conversation_id: state.conversation_id,
    rework_count: state.rework_count + 1
  };
}

async function buildReviewPacket({ task, state, changeset, reviewId }) {
  return {
    schema_version: REVIEW_PACKET_SCHEMA,
    task_id: task.task_id,
    contract_sha: task.contract_sha256,
    attempt: state.attempt,
    rework_count: state.rework_count,
    review_id: reviewId,
    worker: 'antigravity',
    conversation_id: state.conversation_id,
    changed_files: changeset.changed_files,
    changeset_snapshot: {
      signature: changeset.signature,
      head: git(state.workspace, 'rev-parse', 'HEAD').trim(),
      files: changeset.changed_files.map(({ content: ignored, ...file }) => file)
    },
    tests: state.tests,
    acceptance_criteria: task.acceptance_criteria,
    review_result: null,
    requested_changes: state.requested_changes,
    created_at: new Date().toISOString(),
    changeset_signature: changeset.signature,
    diff: changeset.diff
  };
}

async function reviewPendingAttempt({ task, paths, state, config, owner, reviewerInvoker, signal }) {
  const claim = await claimFromDisk(paths.taskPath);
  await validateLease(paths.taskPath, { owner, token: claim.lease_token, version: state.lease?.version });
  const packet = await optionalJson(paths.reviewPacketPath);
  if (!packet || packet.schema_version !== REVIEW_PACKET_SCHEMA || packet.task_id !== task.task_id || packet.review_id !== state.review_id) {
    const error = fail('STATE_CORRUPTION', 'pending review packet is missing or does not match lifecycle state', { task_id: task.task_id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.RECOVERY_REQUIRED, status: LIFECYCLE_STATES.RECOVERY_REQUIRED, recovery: { required: true, reason: 'review packet is not recoverable' }, error }, claim);
    return resultOf(state);
  }
  const current = await buildChangesetPacket(state.workspace, task, state.tests);
  if (current.signature !== packet.changeset_signature) {
    const error = fail('REVIEW_STALE', 'workspace changed while review was paused', { task_id: task.task_id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_FOR_REVIEW, status: LIFECYCLE_STATES.READY_FOR_REVIEW, pending_review: true, error }, claim);
    return resultOf(state);
  }
  const control = assertDispatchAllowed(await readDesiredState(state.repo_root, config));
  const protectedSnapshot = await snapshotProtected(protectedControlPaths(paths));
  const review = packet.review_result ?? await independentReview({ task, packet, config, packetDir: paths.packetDir, cwd: state.workspace, state, signal, reviewerInvoker });
  await validateLease(paths.taskPath, { owner, token: claim.lease_token, version: claim.version });
  await assertProtectedUnchanged(protectedSnapshot);
  packet.review_result = review;
  await writeFencedJson(paths, paths.reviewPacketPath, packet, claim, state.state_revision);
  state.review_result = review;
  state.pending_review = false;
  state.requested_changes = review.verdict === 'REQUEST_CHANGES' ? [requestFor(review, state, review.material_findings.join('\n') || review.summary)] : [];
  if (review.verdict === 'REQUEST_CHANGES') {
    state.request_history = [...(state.request_history ?? []), ...state.requested_changes.slice(-1)];
    state.rework_count += 1;
    if (state.rework_count >= state.max_rework) {
      state.phase = LIFECYCLE_STATES.RETRY_EXHAUSTED;
      state.status = LIFECYCLE_STATES.RETRY_EXHAUSTED;
      const reviewOperationId = state.in_flight?.id ?? state.latest_execution?.operation_id ?? null;
      state.error = errorRecord(fail('RETRY_EXHAUSTED', 'maximum rework count has been reached', { task_id: task.task_id, operation: reviewOperationId }), { taskId: task.task_id, operation: reviewOperationId });
    } else {
      state.phase = LIFECYCLE_STATES.REWORKING;
      state.status = LIFECYCLE_STATES.REQUEST_CHANGES;
    }
  } else if (review.verdict === 'PASS' && state.tests.every(test => test.code === 0 && !test.timed_out && !test.interrupted)) {
    state.phase = LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT;
    state.status = LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT;
  } else {
    state.phase = LIFECYCLE_STATES.BLOCKED;
    state.status = LIFECYCLE_STATES.BLOCKED;
    state.error = errorRecord(fail('REVIEW_FAILED', review.summary || 'Codex review did not pass', { task_id: task.task_id }), { taskId: task.task_id });
  }
  state.history.push({ operation_id: state.in_flight?.id ?? null, phase: 'review', review_id: review.review_id, at: new Date().toISOString(), verdict: review.verdict, tests: state.tests.length });
  await saveState(state, paths, { phase: state.phase, status: state.status, pending_review: false, error: state.error ?? null }, claim);
  await operationEvent(paths.packetDir, 'review_completed', transitionFields(state, { operation_id: state.in_flight?.id ?? null, result: review.verdict, error_code: state.error?.code ?? null }));
  await auditEvent(paths.packetDir, 'review_completed', transitionFields(state, { operation_id: state.latest_execution?.operation_id ?? null, result: review.verdict, error_code: state.error?.code ?? null }));
  return resultOf(state);
}

async function executeAttempt({ task, paths, state, config, owner, worker, continuation, instruction, reviewerInvoker, signal }) {
  const savedClaim = await claimFromDisk(paths.taskPath);
  const { claim } = await validateLease(paths.taskPath, { owner, token: savedClaim.lease_token, version: state.lease?.version });
  const control = assertDispatchAllowed(await readDesiredState(state.repo_root, config));
  const headBefore = git(state.workspace, 'rev-parse', 'HEAD').trim();
  const previousSignature = state.changeset_signature;
  if (!continuation && state.attempt === 0) await assertInitialWorktreeClean(task, state.workspace);
  const nextAttempt = continuation ? state.attempt + 1 : 1;
  const operationKey = stableOperationId(task.task_id, continuation ? 'continue' : 'execute', nextAttempt, state.rework_count, task.contract_sha256);
  const operation = {
    id: operationKey,
    idempotency_key: operationKey,
    kind: continuation ? 'continue' : 'execute',
    invocation_kind: continuation ? 'continue' : 'execute',
    attempt: nextAttempt,
    rework_count: state.rework_count,
    started_at: new Date().toISOString()
  };
  await saveState(state, paths, {
    phase: LIFECYCLE_STATES.RUNNING,
    status: LIFECYCLE_STATES.RUNNING,
    in_flight: operation,
    desired_state: control.state,
    lease: leaseSummary(claim)
  }, claim);
  await operationEvent(paths.packetDir, 'dispatch_started', transitionFields(state, { operation_id: operation.id, result: operation.kind }));
  await auditEvent(paths.packetDir, 'dispatch_started', transitionFields(state, { operation_id: operation.id, result: operation.kind }));
  const protectedSnapshot = await snapshotProtected(protectedControlPaths(paths));
  const prompt = `Implement the frozen task in the current worktree. Goal: ${task.goal ?? '(see acceptance criteria)'}. Only edit the frozen allowed_paths (${JSON.stringify(task.allowed_paths ?? task.write_paths ?? [])}) and run the relevant tests (${JSON.stringify(task.gates ?? [])}). Do not modify ai-control.desired_state, task packets, claim/lease files, receipts, checkpoints or routing. Do not commit, reset, clean, merge, publish or deploy. Leave changes for Harness review. Acceptance criteria: ${JSON.stringify(task.acceptance_criteria)}`;
  let workerResult;
  let processRelease = null;
  try {
    processRelease = await acquire(state.workspace);
    workerResult = continuation ? await worker.continue(task, instruction, operation) : await worker.execute(task, prompt, operation);
  } catch (error) {
    const mapped = error?.harness ? error : fail(error?.code ?? 'EXECUTION_OUTCOME_UNKNOWN', error?.message ?? 'worker execution outcome is unknown', { task_id: task.task_id, operation: operation.id });
    const uncertain = ['MCP_UNAVAILABLE', 'WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'MCP_PROTOCOL_ERROR'].includes(mapped.code);
    if (uncertain) {
      await saveState(state, paths, {
        phase: LIFECYCLE_STATES.RECOVERY_REQUIRED,
        status: LIFECYCLE_STATES.RECOVERY_REQUIRED,
        recovery: { required: true, reason: 'worker call ended before a trusted result was persisted', operation_id: operation.id, outcome_code: mapped.code, original_conversation_id: state.conversation_id },
        error: mapped
      }, claim);
      await operationEvent(paths.packetDir, 'recovery_required', transitionFields(state, { operation_id: operation.id, result: mapped.code, error_code: mapped.code }));
      await auditEvent(paths.packetDir, 'recovery_required', transitionFields(state, { operation_id: operation.id, result: mapped.code, error_code: mapped.code }));
      return resultOf(state);
    }
    await saveState(state, paths, { phase: LIFECYCLE_STATES.FAILED, status: LIFECYCLE_STATES.FAILED, in_flight: null, error: mapped }, claim);
    throw mapped;
  } finally {
    await processRelease?.();
  }
  await validateLease(paths.taskPath, { owner, token: claim.lease_token, version: claim.version });
  try { await assertProtectedUnchanged(protectedSnapshot); }
  catch (error) {
    await saveState(state, paths, { phase: LIFECYCLE_STATES.BLOCKED, status: LIFECYCLE_STATES.BLOCKED, in_flight: null, latest_execution: safeWorkerResult(workerResult), error }, claim);
    throw error;
  }
  if (git(state.workspace, 'rev-parse', 'HEAD').trim() !== headBefore) {
    const error = fail('AUTO_COMMIT_DETECTED', 'worker changed Git HEAD; implementation lifecycle never commits');
    await saveState(state, paths, { phase: LIFECYCLE_STATES.BLOCKED, status: LIFECYCLE_STATES.BLOCKED, in_flight: null, latest_execution: safeWorkerResult(workerResult), error }, claim);
    throw error;
  }
  const correlationError = workerResult?.status === 'NO_RESULT' || workerResult?.error_code === 'NO_RESULT'
    ? null
    : resultCorrelationError(task, workerResult, operation, continuation ? state.conversation_id : null);
  if (correlationError) {
    return persistRecovery(state, paths, claim, errorRecord(correlationError, { taskId: task.task_id, operation: operation.id }), 'mcp_result_correlation_mismatch', operation);
  }
  if (workerResult?.status !== 'SUCCEEDED' || workerResult.agent_status !== 'SUCCESS' || workerResult.exit_code !== 0) {
    const error = workerError(workerResult, task.task_id, operation.id);
    const uncertain = error.code === 'WORKER_TIMEOUT' || error.code === 'WORKER_OUTPUT_LIMIT';
    await saveState(state, paths, {
      phase: uncertain ? LIFECYCLE_STATES.RECOVERY_REQUIRED : LIFECYCLE_STATES.FAILED,
      status: uncertain ? LIFECYCLE_STATES.RECOVERY_REQUIRED : LIFECYCLE_STATES.FAILED,
      in_flight: uncertain ? operation : null,
      recovery: uncertain ? { required: true, reason: 'worker result is not sufficient to prove final workspace outcome', operation_id: operation.id, original_conversation_id: state.conversation_id } : null,
      latest_execution: safeWorkerResult(workerResult),
      error
    }, claim);
    return resultOf(state);
  }
  if (!workerResult.conversation_id) {
    const error = fail('CONVERSATION_LOST', 'successful Antigravity execution has no conversation_id', { task_id: task.task_id, operation: operation.id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.RECOVERY_REQUIRED, status: LIFECYCLE_STATES.RECOVERY_REQUIRED, in_flight: operation, recovery: { required: true, reason: 'conversation id missing', operation_id: operation.id }, latest_execution: safeWorkerResult(workerResult), error }, claim);
    throw error;
  }
  if (continuation && workerResult.conversation_id !== state.conversation_id) {
    const error = fail('CONVERSATION_LOST', 'antigravity_continue did not reuse the original conversation', { task_id: task.task_id, operation: operation.id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.RECOVERY_REQUIRED, status: LIFECYCLE_STATES.RECOVERY_REQUIRED, in_flight: operation, recovery: { required: true, reason: 'conversation id changed or was lost', operation_id: operation.id, original_conversation_id: state.conversation_id }, latest_execution: safeWorkerResult(workerResult), error }, claim);
    throw error;
  }
  const latest = safeWorkerResult(workerResult);
  latest.operation_id = operation.id;
  latest.duration_ms = Date.now() - Date.parse(operation.started_at);
  await assertProtectedUnchanged(protectedSnapshot);
  await writeFencedJson(paths, paths.workerResultPath, latest, claim, state.state_revision);
  const postWorkerProtectedSnapshot = await snapshotProtected(protectedControlPaths(paths));
  let testRun;
  let changeset;
  try {
    testRun = await runTests(task, state.workspace, signal);
    changeset = await buildChangesetPacket(state.workspace, task, testRun.tests, continuation ? previousSignature : null);
  } catch (error) {
    if (isLeaseError(error)) throw error;
    const mapped = error?.harness ? error : fail('WORKER_EXECUTION_FAILED', error?.message ?? 'post-worker verification failed', { task_id: task.task_id, operation: operation.id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.BLOCKED, status: LIFECYCLE_STATES.BLOCKED, in_flight: null, latest_execution: latest, error: mapped }, claim);
    await operationEvent(paths.packetDir, 'worker_failed', transitionFields(state, { operation_id: operation.id, result: mapped.code, error_code: mapped.code }));
    await auditEvent(paths.packetDir, 'worker_failed', transitionFields(state, { operation_id: operation.id, result: mapped.code, error_code: mapped.code }));
    return resultOf(state);
  }
  await validateLease(paths.taskPath, { owner, token: claim.lease_token, version: claim.version });
  await assertProtectedUnchanged(postWorkerProtectedSnapshot);
  state.attempt = nextAttempt;
  state.conversation_id = workerResult.conversation_id;
  state.latest_execution = latest;
  state.changed_files = changeset.changed_files.map(({ content: ignored, ...file }) => file);
  state.changeset_signature = changeset.signature;
  if (!state.baseline_changeset_signature) state.baseline_changeset_signature = changeset.signature;
  state.tests = testRun.tests;
  state.in_flight = null;
  state.phase = LIFECYCLE_STATES.READY_FOR_REVIEW;
  state.status = LIFECYCLE_STATES.READY_FOR_REVIEW;
  state.history.push({ operation_id: operation.id, phase: continuation ? 'continue' : 'execute', attempt: nextAttempt, at: new Date().toISOString(), worker: 'antigravity', conversation_id: workerResult.conversation_id, changed_files: state.changed_files, tests: testRun.status });
  await saveState(state, paths, { phase: state.phase, status: state.status, in_flight: null, latest_execution: latest }, claim);
  await operationEvent(paths.packetDir, 'worker_completed', transitionFields(state, { operation_id: operation.id, result: workerResult.status, duration_ms: latest.duration_ms }));
  await auditEvent(paths.packetDir, 'worker_completed', transitionFields(state, { operation_id: operation.id, result: workerResult.status, duration_ms: latest.duration_ms }));
  const afterWorkerControl = await readDesiredState(state.repo_root, config);
  if (afterWorkerControl.state !== 'running') {
    const reviewId = reviewIdFor(task, state.attempt, state.rework_count);
    state.review_id = reviewId;
    const pendingPacket = await buildReviewPacket({ task, state, changeset, reviewId });
    await writeFencedJson(paths, paths.reviewPacketPath, pendingPacket, claim, state.state_revision);
    await saveState(state, paths, {
      phase: LIFECYCLE_STATES.PAUSED,
      status: LIFECYCLE_STATES.PAUSED,
      desired_state: afterWorkerControl.state,
      review_id: reviewId,
      pending_review: true,
      resume_phase: LIFECYCLE_STATES.READY_FOR_REVIEW,
      error: fail('DESIRED_STATE_BLOCKED', `desired_state=${afterWorkerControl.state} blocks review`, { task_id: task.task_id, operation: operation.id })
    }, claim);
    return resultOf(state);
  }
  const reviewId = reviewIdFor(task, state.attempt, state.rework_count);
  state.review_id = reviewId;
  const packet = await buildReviewPacket({ task, state, changeset, reviewId });
  await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_FOR_REVIEW, status: LIFECYCLE_STATES.READY_FOR_REVIEW, review_id: reviewId, pending_review: true }, claim);
  const reviewProtectedSnapshot = await snapshotProtected(protectedControlPaths(paths));
  const review = await independentReview({ task, packet, config, packetDir: paths.packetDir, cwd: state.workspace, state, signal, reviewerInvoker });
  await validateLease(paths.taskPath, { owner, token: claim.lease_token, version: claim.version });
  await assertProtectedUnchanged(reviewProtectedSnapshot);
  const reviewedChangeset = await buildChangesetPacket(state.workspace, task, state.tests);
  if (reviewedChangeset.signature !== changeset.signature) {
    const stale = fail('REVIEW_STALE', 'workspace changed after the review snapshot', { task_id: task.task_id, operation: operation.id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_FOR_REVIEW, status: LIFECYCLE_STATES.READY_FOR_REVIEW, pending_review: true, error: stale }, claim);
    return resultOf(state);
  }
  packet.review_result = review;
  await writeFencedJson(paths, paths.reviewPacketPath, packet, claim, state.state_revision);
  state.review_result = review;
  state.pending_review = false;
  state.requested_changes = review.verdict === 'REQUEST_CHANGES' ? [requestFor(review, state, review.material_findings.join('\n') || review.summary)] : state.requested_changes;
  if (review.verdict === 'REQUEST_CHANGES') state.request_history = [...(state.request_history ?? []), ...state.requested_changes.slice(-1)];
  if (review.verdict === 'REQUEST_CHANGES') {
    state.rework_count += 1;
    if (state.rework_count >= state.max_rework) {
      state.phase = LIFECYCLE_STATES.RETRY_EXHAUSTED;
      state.status = LIFECYCLE_STATES.RETRY_EXHAUSTED;
      state.error = errorRecord(fail('RETRY_EXHAUSTED', 'maximum rework count has been reached', { task_id: task.task_id }), { taskId: task.task_id });
    } else {
      state.phase = LIFECYCLE_STATES.REWORKING;
      state.status = LIFECYCLE_STATES.REQUEST_CHANGES;
    }
  } else if (review.verdict === 'PASS' && testRun.status === 'PASS') {
    state.requested_changes = [];
    state.phase = LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT;
    state.status = LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT;
  } else {
    state.phase = LIFECYCLE_STATES.BLOCKED;
    state.status = LIFECYCLE_STATES.BLOCKED;
    state.error = errorRecord(fail('REVIEW_FAILED', review.summary || 'Codex review did not pass', { task_id: task.task_id, operation: operation.id }), { taskId: task.task_id, operation: operation.id });
  }
  state.history.push({ operation_id: operation.id, phase: 'review', review_id: review.review_id, at: new Date().toISOString(), verdict: review.verdict, tests: testRun.status });
  await saveState(state, paths, { phase: state.phase, status: state.status, in_flight: null, error: state.error ?? null }, claim);
  await operationEvent(paths.packetDir, 'review_completed', transitionFields(state, { operation_id: operation.id, result: review.verdict, error_code: state.error?.code ?? null }));
  await auditEvent(paths.packetDir, 'review_completed', transitionFields(state, { operation_id: operation.id, result: review.verdict, error_code: state.error?.code ?? null }));
  return resultOf(state);
}

export async function runHarnessLifecycle(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'run');
  await assertControlledContract(options.taskPath, task);
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  await mkdir(paths.packetDir, { recursive: true });
  let state = await stateFor(paths);
  const newLifecycle = !state;
  if (state) {
    await checkStateIdentity(task, state);
    if (terminal(state)) return resultOf(state);
    if (state.phase === LIFECYCLE_STATES.RECOVERY_REQUIRED) return resultOf(state);
    if (SAFE_STOP_SET.has(state.phase)) return safeStopResult(state, task.task_id);
    if (state.phase === LIFECYCLE_STATES.RUNNING || state.in_flight) {
      const error = fail('RECOVERY_REQUIRED', 'previous Harness process stopped during an in-flight worker operation', { task_id: task.task_id, operation: state.in_flight?.id ?? null });
      return { ...resultOf(state), status: LIFECYCLE_STATES.RECOVERY_REQUIRED, phase: LIFECYCLE_STATES.RECOVERY_REQUIRED, recovery: { required: true, reason: 'in-flight operation has no trusted completion result', operation_id: state.in_flight?.id ?? null }, error: errorRecord(error, { taskId: task.task_id, operation: state.in_flight?.id ?? null }) };
    }
    if (state.phase === LIFECYCLE_STATES.REWORKING) return options.resume ? continueHarnessLifecycle(options) : resultOf(state);
    if (state.phase === LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT || state.phase === LIFECYCLE_STATES.CHECKPOINTED) return resultOf(state);
  }
  const owner = ownerOf(options, state, config);
  let claim;
  try { claim = await ensureClaim(options.taskPath, paths, state, owner, config); }
  catch (error) {
    if (error.code === 'ALREADY_CLAIMED') return { status: 'ALREADY_CLAIMED', task_id: task.task_id, claim: error.claim ?? null, error: errorRecord(error, { taskId: task.task_id }) };
    throw error;
  }
  const control = await readDesiredState(repositoryRoot(path.dirname(options.taskPath)), config);
  if (state && state.owner !== owner) throw fail('LEASE_OWNER_MISMATCH', 'task is owned by another Harness owner');
  const worktree = await resolveTaskWorktree(task.task_id, { task, taskPath: options.taskPath, repoRoot: repositoryRoot(path.dirname(options.taskPath)), config });
  const pendingReview = state?.pending_review === true;
  if (!state) state = initialState(task, paths, claim, worktree, control, config);
  else {
    state.owner = owner;
    state.lease = leaseSummary(claim);
    state.workspace = worktree.workspace;
    state.worktree_root = worktree.worktreeRoot;
    state.repo_root = worktree.repoRoot;
    state.desired_state = control.state;
    state.phase = pendingReview ? LIFECYCLE_STATES.READY_FOR_REVIEW : LIFECYCLE_STATES.CLAIMED;
    state.status = pendingReview ? LIFECYCLE_STATES.READY_FOR_REVIEW : LIFECYCLE_STATES.CLAIMED;
  }
  await saveState(state, paths, { phase: state.phase, status: state.status }, claim);
  if (newLifecycle) {
    await auditEvent(paths.packetDir, 'task_initialized', transitionFields(state, { previous_state: 'FROZEN', next_state: state.phase, result: 'CLAIMED' }));
    await auditEvent(paths.packetDir, 'frozen', transitionFields(state, { previous_state: 'FROZEN', next_state: 'CLAIMED', result: 'FROZEN' }));
  }
  try {
    assertDispatchAllowed(control);
  } catch (error) {
    await saveState(state, paths, { phase: LIFECYCLE_STATES.PAUSED, status: LIFECYCLE_STATES.PAUSED, desired_state: control.state, error: error.message }, claim);
    state.lease = null;
    await saveState(state, paths, { lease: null, error: state.error ?? null }, claim);
    await releaseLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
    return resultOf(state);
  }
  await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_TO_DISPATCH, status: LIFECYCLE_STATES.READY_TO_DISPATCH }, claim);
  if (pendingReview) {
    try { return await reviewPendingAttempt({ task, paths, state, config, owner, reviewerInvoker: options.reviewerInvoker, signal: options.signal }); }
    catch (error) {
      if (isLeaseError(error)) return { status: error.code, task_id: task.task_id, error: errorRecord(error, { taskId: task.task_id }) };
      throw error;
    }
  }
  const worker = mcpWorkerFor(options, config, worktree);
  try {
    try { assertWorkerIsolation(config); }
    catch (error) {
      await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_TO_DISPATCH, status: LIFECYCLE_STATES.READY_TO_DISPATCH, error }, claim);
      return resultOf(state);
    }
    try { if (typeof worker.tools === 'function') await worker.tools(); }
    catch (error) {
      const unavailable = error?.harness ? error : fail(error?.code === 'MCP_PROTOCOL_ERROR' ? 'MCP_PROTOCOL_ERROR' : 'MCP_UNAVAILABLE', error?.message ?? 'MCP worker is unavailable', { task_id: task.task_id });
      await saveState(state, paths, { phase: LIFECYCLE_STATES.READY_TO_DISPATCH, status: LIFECYCLE_STATES.READY_TO_DISPATCH, error: unavailable }, claim);
      await operationEvent(paths.packetDir, 'mcp_unavailable', transitionFields(state, { result: 'MCP_UNAVAILABLE', error_code: unavailable.code }));
      await auditEvent(paths.packetDir, 'mcp_unavailable', transitionFields(state, { result: 'MCP_UNAVAILABLE', error_code: unavailable.code }));
      return resultOf(state);
    }
    return await executeAttempt({ task, paths, state, config, owner, worker, continuation: false, reviewerInvoker: options.reviewerInvoker, signal: options.signal });
  } catch (error) {
    if (isLeaseError(error)) return { status: error.code, task_id: task.task_id, error: errorRecord(error, { taskId: task.task_id }) };
    throw error;
  } finally {
    if (options.closeWorker === true) await releaseWorker({ ...options, config }, worker, worktree);
  }
}

export async function requestChanges(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'request-changes');
  await assertControlledContract(options.taskPath, task);
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (terminal(state)) return resultOf(state);
  if (state.phase === LIFECYCLE_STATES.RECOVERY_REQUIRED) return resultOf(state);
  const owner = ownerOf(options, state, config);
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  const instruction = text(options.instruction, 'REQUEST_CHANGES instruction is required');
  if (state.phase === LIFECYCLE_STATES.REWORKING || state.status === LIFECYCLE_STATES.REQUEST_CHANGES) {
    const previous = state.requested_changes.at(-1)?.instruction;
    if (previous && previous !== instruction) throw fail('IDEMPOTENCY_CONFLICT', 'task already has a different pending REQUEST_CHANGES instruction', { task_id: task.task_id });
    return resultOf(state);
  }
  if (state.phase !== LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT) throw fail('INVALID_TRANSITION', 'REQUEST_CHANGES requires a completed review');
  if (state.rework_count >= state.max_rework) {
    const error = fail('RETRY_EXHAUSTED', 'maximum rework count has been reached', { task_id: task.task_id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.RETRY_EXHAUSTED, status: LIFECYCLE_STATES.RETRY_EXHAUSTED, error }, claim);
    return resultOf(state);
  }
  const request = requestFor(state.review_result ?? {}, state, instruction);
  if (state.request_history.some(item => item.id === request.id)) return resultOf(state);
  state.rework_count += 1;
  state.requested_changes = [request];
  state.request_history = [...(state.request_history ?? []), request];
  state.review_result = { ...(state.review_result ?? {}), verdict: 'REQUEST_CHANGES', summary: instruction, material_findings: [instruction], risk_checks_completed: true };
  const packet = await optionalJson(paths.reviewPacketPath);
  if (packet) {
    packet.review_result = state.review_result;
    packet.requested_changes = state.requested_changes;
    await writeFencedJson(paths, paths.reviewPacketPath, packet, claim, state.state_revision);
  }
  await saveState(state, paths, { phase: LIFECYCLE_STATES.REWORKING, status: LIFECYCLE_STATES.REQUEST_CHANGES, rework_count: state.rework_count }, claim);
  await operationEvent(paths.packetDir, 'request_changes', transitionFields(state, { result: 'REQUEST_CHANGES', error_code: null }));
  await auditEvent(paths.packetDir, 'request_changes', transitionFields(state, { result: 'REQUEST_CHANGES', error_code: null }));
  return resultOf(state);
}

export async function continueHarnessLifecycle(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'continue');
  await assertControlledContract(options.taskPath, task);
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (terminal(state)) return resultOf(state);
  if (state.phase === LIFECYCLE_STATES.RECOVERY_REQUIRED) return resultOf(state);
  const owner = ownerOf(options, state, config);
  let currentClaim;
  try {
    currentClaim = await claimFromDisk(options.taskPath);
    await validateLease(options.taskPath, { owner, token: currentClaim.lease_token, version: currentClaim.version });
  } catch (error) {
    return { status: error.code ?? 'LEASE_INVALID', task_id: task.task_id, error: errorRecord(error, { taskId: task.task_id }) };
  }
  if (state.phase !== LIFECYCLE_STATES.REWORKING) return resultOf(state);
  if (!state.conversation_id) throw fail('CONVERSATION_MISSING', 'cannot continue without the original conversation_id');
  const control = assertDispatchAllowed(await readDesiredState(state.repo_root, config));
  const worktree = await resolveTaskWorktree(task.task_id, { task, taskPath: options.taskPath, repoRoot: state.repo_root, config });
  const worker = WORKERS.get(`${worktree.repoRoot}:${worktree.workspace}:${config.worker.server}`) ?? options.worker;
  if (!worker) {
    const error = fail('CONVERSATION_LOST', 'active MCP conversation is unavailable after worker restart', { task_id: task.task_id });
    await saveState(state, paths, { phase: LIFECYCLE_STATES.RECOVERY_REQUIRED, status: LIFECYCLE_STATES.RECOVERY_REQUIRED, recovery: { required: true, reason: 'conversation_resume_after_mcp_restart=false', original_conversation_id: state.conversation_id }, error }, currentClaim);
    await operationEvent(paths.packetDir, 'conversation_lost', transitionFields(state, { result: 'RECOVERY_REQUIRED', error_code: error.code }));
    await auditEvent(paths.packetDir, 'conversation_lost', transitionFields(state, { result: 'RECOVERY_REQUIRED', error_code: error.code }));
    return resultOf(state);
  }
  const instruction = options.instruction ?? state.requested_changes.at(-1)?.instruction;
  try {
    try { assertWorkerIsolation(config); }
    catch (error) {
      await saveState(state, paths, { phase: LIFECYCLE_STATES.REWORKING, status: LIFECYCLE_STATES.REQUEST_CHANGES, error }, currentClaim);
      return resultOf(state);
    }
    try { if (typeof worker.tools === 'function') await worker.tools(); }
    catch (error) {
      const unavailable = error?.harness ? error : fail(error?.code === 'MCP_PROTOCOL_ERROR' ? 'MCP_PROTOCOL_ERROR' : 'MCP_UNAVAILABLE', error?.message ?? 'MCP worker is unavailable', { task_id: task.task_id });
      await saveState(state, paths, { phase: LIFECYCLE_STATES.REWORKING, status: LIFECYCLE_STATES.REQUEST_CHANGES, error: unavailable }, currentClaim);
      await operationEvent(paths.packetDir, 'mcp_unavailable', transitionFields(state, { result: 'MCP_UNAVAILABLE', error_code: unavailable.code }));
      await auditEvent(paths.packetDir, 'mcp_unavailable', transitionFields(state, { result: 'MCP_UNAVAILABLE', error_code: unavailable.code }));
      return resultOf(state);
    }
    return await executeAttempt({ task, paths, state, config, owner, worker, continuation: true, instruction: text(instruction, 'continue instruction is required'), reviewerInvoker: options.reviewerInvoker, signal: options.signal });
  } catch (error) {
    if (isLeaseError(error)) return { status: error.code, task_id: task.task_id, error: errorRecord(error, { taskId: task.task_id }) };
    throw error;
  } finally {
    if (options.closeWorker === true) await releaseWorker({ ...options, config }, worker, worktree);
  }
}

export async function approveCheckpoint(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'checkpoint');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (terminal(state)) return resultOf(state);
  if (state.phase === LIFECYCLE_STATES.CHECKPOINTED && state.checkpoint?.approved === true) return resultOf(state);
  const owner = ownerOf(options, state, config);
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  assertDispatchAllowed(await readDesiredState(state.repo_root, config));
  if (state.phase !== LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT) throw fail('CHECKPOINT_REQUIRED', 'task is not waiting for a checkpoint');
  if (state.review_result?.verdict !== 'PASS' || state.review_result?.risk_checks_completed !== true || state.tests.some(test => test.code !== 0 || test.timed_out || test.interrupted)) throw fail('CHECKPOINT_REJECTED', 'checkpoint requires passing review and tests');
  const current = await buildChangesetPacket(state.workspace, task, state.tests);
  if (current.signature !== state.changeset_signature) throw fail('REVIEW_STALE', 'workspace changed before checkpoint approval', { task_id: task.task_id });
  const approvedBy = text(options.approvedBy, 'explicit checkpoint approver is required');
  const checkpointId = `checkpoint-${hash(`${task.task_id}:${state.review_id}:${state.changeset_signature}`).slice(0, 32)}`;
  state.checkpoint = {
    required: state.checkpoint.required,
    approved: true,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    checkpoint_id: checkpointId,
    task_id: task.task_id,
    contract_sha256: task.contract_sha256,
    review_id: state.review_id,
    changeset_signature: state.changeset_signature,
    attempt: state.attempt,
    rework_count: state.rework_count
  };
  await saveState(state, paths, { phase: LIFECYCLE_STATES.CHECKPOINTED, status: LIFECYCLE_STATES.CHECKPOINTED }, claim);
  await operationEvent(paths.packetDir, 'checkpoint_approved', transitionFields(state, { result: checkpointId }));
  await auditEvent(paths.packetDir, 'checkpoint_approved', transitionFields(state, { result: checkpointId }));
  return resultOf(state);
}

export async function rejectCheckpoint(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'checkpoint-reject');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (state.phase === LIFECYCLE_STATES.CHECKPOINT_REJECTED) return resultOf(state);
  const owner = ownerOf(options, state, config);
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  if (![LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT, LIFECYCLE_STATES.CHECKPOINTED].includes(state.phase)) throw fail('CHECKPOINT_NOT_READY', 'task is not waiting for a checkpoint decision');
  const reason = text(options.reason, 'explicit checkpoint rejection reason is required');
  state.checkpoint = { ...(state.checkpoint ?? {}), approved: false, rejected: true, rejected_by: text(options.rejectedBy ?? owner, 'checkpoint rejector is required'), rejected_at: new Date().toISOString(), rejection_reason: reason };
  const error = fail('CHECKPOINT_REJECTED', reason, { task_id: task.task_id });
  await saveState(state, paths, { phase: LIFECYCLE_STATES.CHECKPOINT_REJECTED, status: LIFECYCLE_STATES.CHECKPOINT_REJECTED, error }, claim);
  await operationEvent(paths.packetDir, 'checkpoint_rejected', transitionFields(state, { result: 'CHECKPOINT_REJECTED', error_code: error.code }));
  await auditEvent(paths.packetDir, 'checkpoint_rejected', transitionFields(state, { result: 'CHECKPOINT_REJECTED', error_code: error.code }));
  return resultOf(state);
}

export async function completeTask(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'complete');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (terminal(state)) {
    const receipt = await optionalJson(paths.completionReceiptPath);
    if (!receipt || receipt.task_id !== task.task_id || receipt.completion_id !== state.completion?.completion_id) throw fail('STATE_CORRUPTION', 'completed task is missing its immutable completion receipt', { task_id: task.task_id });
    return resultOf({ ...state, completion: receipt });
  }
  const owner = ownerOf(options, state, config);
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  assertDispatchAllowed(await readDesiredState(state.repo_root, config));
  if (state.phase !== LIFECYCLE_STATES.CHECKPOINTED || (state.checkpoint.required && !state.checkpoint.approved)) throw fail('CHECKPOINT_REQUIRED', 'completion requires an explicit checkpoint approval', { task_id: task.task_id });
  if (state.review_result?.verdict !== 'PASS' || state.review_result?.risk_checks_completed !== true || state.requested_changes.length > 0 || state.tests.some(test => test.code !== 0 || test.timed_out || test.interrupted)) throw fail('COMPLETION_GUARD', 'completion has unresolved review or test findings');
  if (state.checkpoint.task_id !== task.task_id || state.checkpoint.contract_sha256 !== task.contract_sha256 || state.checkpoint.review_id !== state.review_id || state.checkpoint.changeset_signature !== state.changeset_signature) throw fail('CHECKPOINT_REJECTED', 'checkpoint is bound to a different task, review or changeset', { task_id: task.task_id });
  const current = await buildChangesetPacket(state.workspace, task, state.tests);
  if (current.signature !== state.changeset_signature) throw fail('REVIEW_STALE', 'workspace changed after review/checkpoint', { task_id: task.task_id });
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  const receipt = {
    schema_version: 'qq.workflow.completion-receipt.v1',
    completion_id: `completion-${hash(`${task.task_id}:${state.checkpoint.checkpoint_id}:${state.changeset_signature}`).slice(0, 32)}`,
    task_id: task.task_id,
    contract_sha256: task.contract_sha256,
    review_id: state.review_id,
    checkpoint_id: state.checkpoint.checkpoint_id,
    changeset_signature: state.changeset_signature,
    repo_head: git(state.workspace, 'rev-parse', 'HEAD').trim(),
    repo_tree: git(state.workspace, 'rev-parse', 'HEAD^{tree}').trim(),
    attempt: state.attempt,
    rework_count: state.rework_count,
    completed_at: new Date().toISOString(),
    completed_by: owner,
    committed: false
  };
  const existingReceipt = await optionalJson(paths.completionReceiptPath);
  if (existingReceipt && JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) throw fail('IDEMPOTENCY_CONFLICT', 'completion receipt already exists with different identity', { task_id: task.task_id });
  if (!existingReceipt) await writeFencedJson(paths, paths.completionReceiptPath, receipt, claim, state.state_revision);
  state.completion = receipt;
  await saveState(state, paths, { phase: LIFECYCLE_STATES.COMPLETED, status: LIFECYCLE_STATES.COMPLETED, completion: receipt }, claim);
  state.lease = null;
  await saveState(state, paths, { lease: null, error: null }, claim);
  await releaseLease(options.taskPath, { owner, token: claim.lease_token, version: claim.version });
  await auditEvent(paths.packetDir, 'completion', transitionFields(state, { result: receipt.completion_id }));
  await operationEvent(paths.packetDir, 'completion', transitionFields(state, { result: receipt.completion_id }));
  return resultOf(state);
}

export async function recoverTask(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'recover');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (state.phase === LIFECYCLE_STATES.BLOCKED && state.recovery?.decision === 'block') return resultOf(state);
  if (state.phase !== LIFECYCLE_STATES.RECOVERY_REQUIRED) throw fail('RECOVERY_REQUIRED', 'task is not waiting for recovery decision', { task_id: task.task_id });
  const operator = text(options.operator ?? options.owner, 'explicit recovery operator is required');
  const reason = text(options.reason, 'explicit recovery reason is required');
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner: operator, token: claim.lease_token, version: state.lease?.version });
  if (options.decision !== 'block') throw fail('INVALID_INPUT', 'safe recovery requires decision=block');
  state.recovery = { ...(state.recovery ?? {}), required: false, decision: 'block', operator, reason, decided_at: new Date().toISOString() };
  const error = fail('RECOVERY_REQUIRED', 'operator blocked the task after an uncertain execution boundary', { task_id: task.task_id });
  await saveState(state, paths, { phase: LIFECYCLE_STATES.BLOCKED, status: LIFECYCLE_STATES.BLOCKED, error }, claim);
  await operationEvent(paths.packetDir, 'recovery_decided', transitionFields(state, { result: 'BLOCKED', error_code: error.code }));
  await auditEvent(paths.packetDir, 'recovery_decided', transitionFields(state, { result: 'BLOCKED', error_code: error.code }));
  return resultOf(state);
}

export async function reconcileTask(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'reconcile');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) throw fail('STATE_MISSING', 'lifecycle state is missing');
  if (terminal(state) || SAFE_STOP_SET.has(state.phase) || !RECONCILABLE_SET.has(state.phase)) return resultOf(state);
  const owner = ownerOf(options, state, config);
  const claim = await claimFromDisk(options.taskPath);
  await validateLease(options.taskPath, { owner, token: claim.lease_token, version: state.lease?.version });
  if (!operationValid(state.in_flight, task)) {
    if (state.phase === LIFECYCLE_STATES.RECOVERY_REQUIRED && !state.in_flight) return resultOf(state);
    const invalid = fail('EXECUTION_OUTCOME_UNKNOWN', 'reconciliation requires a valid persisted in-flight operation', { task_id: task.task_id });
    return persistRecovery(state, paths, claim, errorRecord(invalid, { taskId: task.task_id }), 'invalid_in_flight', state.in_flight ?? null);
  }
  const operation = state.in_flight;
  const worktree = await resolveTaskWorktree(task.task_id, { task, taskPath: options.taskPath, repoRoot: state.repo_root, config });
  const worker = WORKERS.get(`${worktree.repoRoot}:${worktree.workspace}:${config.worker.server}`) ?? options.worker;
  if (!worker || typeof worker.result !== 'function') {
    const error = fail('MCP_UNAVAILABLE', 'MCP worker is unavailable for outcome reconciliation', { task_id: task.task_id });
    return persistRecovery(state, paths, claim, errorRecord(error, { taskId: task.task_id, operation: operation.id }), 'mcp_unavailable', operation);
  }
  let result;
  try { result = await worker.result(task); }
  catch (error) {
    const lost = fail('CONVERSATION_LOST', `MCP result reconciliation failed: ${error.message}`, { task_id: task.task_id });
    return persistRecovery(state, paths, claim, errorRecord(lost, { taskId: task.task_id, operation: operation.id }), 'result_query_failed', operation);
  }
  if (result?.status === 'NO_RESULT' || result?.error_code === 'NO_RESULT') {
    const lost = workerError(result, task.task_id, operation.id);
    return persistRecovery(state, paths, claim, errorRecord(lost, { taskId: task.task_id, operation: operation.id }), 'no_result', operation);
  }
  const correlationError = resultCorrelationError(task, result, operation, state.conversation_id ?? null);
  if (correlationError) {
    return persistRecovery(state, paths, claim, errorRecord(correlationError, { taskId: task.task_id, operation: operation.id }), 'mcp_result_correlation_mismatch', operation);
  }
  if (result.status === 'SUCCEEDED' && (!result.conversation_id || (operation.kind === 'continue' && !state.conversation_id))) {
    const lost = fail('CONVERSATION_LOST', 'successful MCP result has no usable conversation identity', { task_id: task.task_id, operation: operation.id });
    return persistRecovery(state, paths, claim, errorRecord(lost, { taskId: task.task_id, operation: operation.id }), 'conversation_missing', operation);
  }
  if (result.status !== 'SUCCEEDED' || result.agent_status !== 'SUCCESS' || result.exit_code !== 0) {
    const error = workerError(result, task.task_id, operation.id);
    return persistRecovery(state, paths, claim, errorRecord(error, { taskId: task.task_id, operation: operation.id }), 'worker_result_failed', operation);
  }
  const tests = await runTests(task, state.workspace, options.signal);
  const changeset = await buildChangesetPacket(state.workspace, task, tests.tests);
  state.latest_execution = safeWorkerResult(result);
  state.attempt = operation.attempt;
  state.conversation_id = result.conversation_id;
  state.changed_files = changeset.changed_files.map(({ content: ignored, ...file }) => file);
  state.changeset_signature = changeset.signature;
  state.tests = tests.tests;
  state.in_flight = null;
  state.pending_review = true;
  state.recovery = { ...(state.recovery ?? {}), required: false, reconciled_at: new Date().toISOString(), source: 'antigravity_result' };
  state.phase = tests.status === 'PASS' ? LIFECYCLE_STATES.READY_FOR_REVIEW : LIFECYCLE_STATES.BLOCKED;
  state.status = state.phase;
  if (tests.status !== 'PASS') state.error = errorRecord(fail('WORKER_EXECUTION_FAILED', 'reconciled execution has failing independent tests', { task_id: task.task_id }), { taskId: task.task_id });
  const reviewId = reviewIdFor(task, state.attempt, state.rework_count);
  state.review_id = reviewId;
  await writeFencedJson(paths, paths.reviewPacketPath, await buildReviewPacket({ task, state, changeset, reviewId }), claim, state.state_revision);
  await saveState(state, paths, { phase: state.phase, status: state.status, pending_review: state.phase === LIFECYCLE_STATES.READY_FOR_REVIEW, error: state.error ?? null }, claim);
  await operationEvent(paths.packetDir, 'execution_reconciled', transitionFields(state, { result: 'READY_FOR_REVIEW' }));
  await auditEvent(paths.packetDir, 'execution_reconciled', transitionFields(state, { result: 'READY_FOR_REVIEW' }));
  return resultOf(state);
}

export async function healthCheck(options = {}) {
  const config = lifecycleConfig(options.config);
  const repoRoot = path.resolve(options.repoRoot ?? repositoryRoot(path.dirname(options.taskPath ?? process.cwd())));
  const checks = [];
  const check = async (name, action) => {
    try { const value = await action(); checks.push({ name, status: 'PASS', detail: value ?? true }); }
    catch (error) { checks.push({ name, status: 'FAIL', error: errorRecord(error) }); }
  };
  await check('git', async () => path.resolve(git(repoRoot, 'rev-parse', '--show-toplevel').trim()).toLowerCase() === path.resolve(repoRoot).toLowerCase());
  await check('desired_state', async () => readDesiredState(repoRoot, config));
  const worktreeRoot = configuredWorktreeRoot(repoRoot, config);
  await check('worktree_root', async () => { await access(worktreeRoot); return worktreeRoot; });
  await check('state_directory', async () => {
    try { await access(path.join(repoRoot, '.workflow-local')); return { exists: true }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await access(repoRoot); return { exists: false, writable_parent_checked: true }; }
  });
  await check('schemas', async () => ({ lifecycle: LIFECYCLE_SCHEMA, claim: CLAIM_SCHEMA, review_packet: REVIEW_PACKET_SCHEMA }));
  await check('runtime_dependencies', async () => {
    const executable = config.worker.command[0];
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    return { node: process.version, worker_executable: executable, worker_version: version.slice(0, 128) };
  });
  await check('mcp_tools', async () => {
    const worker = new AntigravityMcpWorker({ repoRoot, worktreeRoot, config, timeoutSeconds: config.timeout_seconds });
    try { return await worker.health(); } finally { await worker.close(); }
  });
  return { schema_version: 'qq.workflow.health.v1', status: checks.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', checked_at: new Date().toISOString(), repo_root: repoRoot, checks };
}

export async function inspectTask(options = {}) {
  const config = lifecycleConfig(options.config);
  const task = await loadTask(options.taskPath, 'inspect');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  const claim = await optionalJson(paths.claimPath);
  const control = state?.repo_root ? await readDesiredState(state.repo_root, config) : null;
  return {
    schema_version: 'qq.workflow.task-inspection.v1',
    task_id: task.task_id,
    status: state?.status ?? LIFECYCLE_STATES.FROZEN,
    phase: state?.phase ?? LIFECYCLE_STATES.FROZEN,
    owner: state?.owner ?? claim?.owner ?? null,
    lease: claim ? leaseSummary(claim) : state?.lease ?? null,
    attempt: state?.attempt ?? 0,
    rework_count: state?.rework_count ?? 0,
    desired_state: control,
    worker: state?.worker ?? config.worker.server,
    conversation_id: state?.conversation_id ?? null,
    review: state?.review_result ?? null,
    checkpoint: state?.checkpoint ?? null,
    recovery: state?.recovery ?? null,
    error: state?.error ?? state?.last_error ?? null,
    completion: state?.completion ?? null,
    audit: await auditSummary(paths.packetDir)
  };
}

export async function scanStaleTasks({ packetRoot, now = Date.now, runningSeconds = 900, checkpointSeconds = 3600 } = {}) {
  const root = path.resolve(packetRoot);
  const result = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { schema_version: 'qq.workflow.stale-scan.v1', status: 'PASS', tasks: [] }; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(root, entry.name, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { continue; }
    const reasons = [];
    const updated = Date.parse(state.updated_at ?? state.created_at ?? '');
    if (state.lease?.expires_at && Date.parse(state.lease.expires_at) <= now()) reasons.push('LEASE_EXPIRED');
    if (state.phase === LIFECYCLE_STATES.RUNNING && Number.isFinite(updated) && now() - updated > runningSeconds * 1000) reasons.push('RUNNING_TOO_LONG');
    if (state.phase === LIFECYCLE_STATES.WAITING_FOR_CHECKPOINT && Number.isFinite(updated) && now() - updated > checkpointSeconds * 1000) reasons.push('CHECKPOINT_PENDING_TOO_LONG');
    if (state.phase === LIFECYCLE_STATES.RECOVERY_REQUIRED) reasons.push('RECOVERY_REQUIRED');
    if (state.phase === LIFECYCLE_STATES.RETRY_EXHAUSTED) reasons.push('RETRY_EXHAUSTED');
    if (reasons.length) result.push({ task_id: state.task_id ?? entry.name, phase: state.phase, reasons, updated_at: state.updated_at ?? null });
  }
  return { schema_version: 'qq.workflow.stale-scan.v1', status: 'PASS', checked_at: new Date(now()).toISOString(), tasks: result };
}

export async function lifecycleStatus(options = {}) {
  const task = await loadTask(options.taskPath, 'status');
  const paths = pathsFor(options.taskPath, options.packetDir, task.task_id);
  const state = await stateFor(paths);
  if (!state) return { task_id: task.task_id, status: LIFECYCLE_STATES.FROZEN, phase: LIFECYCLE_STATES.FROZEN, terminal: false, audit: await auditSummary(paths.packetDir) };
  return resultOf({ ...state, audit: await auditSummary(paths.packetDir), completion_receipt: await optionalJson(paths.completionReceiptPath) });
}

export async function closeLifecycleWorkers() {
  for (const [key, worker] of WORKERS) { await worker.close(); WORKERS.delete(key); }
}
