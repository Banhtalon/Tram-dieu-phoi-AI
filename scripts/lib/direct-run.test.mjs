import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDirect, checkDirect, runBounded, runDirect, verifyProductDirect } from './direct-run.mjs';
import * as lifecycle from './harness-lifecycle.mjs';
import { freezeControlledTask } from './controlled-bridge.mjs';

test('one process, at most one repair, close on PASS/block/error and preserve instruction', async () => {
  for (const status of ['WAITING_FOR_CHECKPOINT', 'REQUEST_CHANGES', 'WAITING_QUOTA', 'throw']) {
    const calls = [], worker = {};
    const api = {
      async runHarnessLifecycle(options) { assert.equal(options.worker, worker); calls.push('run'); if (status === 'throw') throw Error('sentinel'); return { status, requested_changes: [{ instruction: 'fix only the target' }] }; },
      async continueHarnessLifecycle(options) { assert.equal(options.worker, worker); assert.match(options.instruction, /fix only the target/); calls.push('continue'); return { status: 'REQUEST_CHANGES' }; },
      async closeLifecycleWorkers() { calls.push('close'); }
    };
    if (status === 'throw') await assert.rejects(runBounded({ worker }, api), /sentinel/);
    else await runBounded({ worker }, api);
    assert.deepEqual(calls, status === 'REQUEST_CHANGES' ? ['run', 'continue', 'close'] : ['run', 'close']);
  }
});

test('real preparation/layout + lifecycle fake boundary, missing helper and paused state block offline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-gemini-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), output = path.join(root, 'packet'), worktrees = path.join(root, 'worktrees');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Direct test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, '.gitignore'), '.workflow-local/\n');
  await writeFile(path.join(repo, 'old.txt'), 'before\n');
  await writeFile(path.join(repo, 'gate.mjs'), "import{readFileSync}from'node:fs';if(readFileSync('old.txt','utf8')!=='after\\n'||readFileSync('new.txt','utf8').trim()!=='created')process.exit(1);");
  git('add', '.'); git('commit', '-m', 'fixture');
  const task = { schema_version: 'qq.workflow.task.v10.1', task_id: 'TASK-DIRECT-TEST', revision: 1, base_sha: git('rev-parse', 'HEAD'), goal: 'update old and create new', acceptance_criteria: ['old=after and new=created'],
    gates: [{ id: 'content', argv: [process.execPath, 'gate.mjs'], timeout_seconds: 20 }], user_visible: false, risk: 'LOW', complexity: 'SIMPLE', execution: { policy: 'CONTROLLED_DELEGATION_V1' },
    write_paths: ['old.txt', 'new.txt'], allowed_paths: ['old.txt', 'new.txt'], lane: 'NORMAL', initial_lane: 'NORMAL', initial_risk: 'LOW', product_check: { applicable: false, reason: 'fixture' }, candidate_head: null, contract_sha256: null };
  const config = { schema_version: 'qq.bridge.v2', billing: 'SUBSCRIPTION_ONLY', mode: 'ASSISTED', timeout_seconds: 30, write_paths: task.write_paths, gate_paths: ['gate.mjs'],
    worker: { transport: 'mcp', server: 'antigravity_worker', provider: 'mcp', command: ['python', 'mcp/antigravity_server.py'], model: 'gemini-3.8-flash-high', local_trial: true, local_trial_root: worktrees, skip_permissions: false },
    reviewer: { provider: 'openai', cli: 'codex', command: ['codex'], model: 'gpt-5.6-luna', effort: 'max' } };
  const m = await prepareDirect(repo, task, config, output), manifest = path.join(output, 'prepared.json');
  await assert.rejects(prepareDirect(repo, task, config, output), /OUTPUT_EXISTS/);
  const control = path.join(repo, '.workflow-local', 'ai-control.desired_state');
  await writeFile(control, 'paused\n');
  await assert.rejects(checkDirect(manifest), /DESIRED_STATE_BLOCKED/);
  await writeFile(control, 'running\n');
  const preparedConfig = JSON.parse(await readFile(m.configPath));
  const helper = preparedConfig.worker.command[1], originalHelper = await readFile(helper);
  await writeFile(helper, 'wrong helper');
  await assert.rejects(checkDirect(manifest), /HELPER_CHANGED/);
  const fail = await runDirect(manifest);
  assert.equal(fail.status, 'BLOCKED'); assert.equal(fail.provider_invocations, 0); assert.equal(fail.error_code, 'HELPER_CHANGED');
  await writeFile(helper, originalHelper);
  // Separate fake frozen task: never write or read real account settings in this test.
  const settings = path.join(root, 'settings.json');
  const settingsBytes = JSON.stringify({ permissions: { allow: ['read_file(existing.txt)'], deny: [] } });
  await writeFile(settings, settingsBytes);
  const fakeConfig = structuredClone(preparedConfig);
  fakeConfig.worker.temporary_permissions.settingsPath = settings;
  const fakeRoot = path.join(path.dirname(m.taskPath), 'fake');
  await mkdir(fakeRoot);
  const fakePath = path.join(fakeRoot, `${task.task_id}.json`);
  await writeFile(fakePath, JSON.stringify(task)); await freezeControlledTask(fakePath, task, fakeConfig);
  const workspace = path.join(worktrees, task.task_id), calls = [];
  const result = op => ({ task_id: task.task_id, status: 'SUCCEEDED', agent_status: 'SUCCESS', exit_code: 0, operation_id: op.id, invocation_kind: op.kind, attempt: op.attempt, rework_count: op.rework_count, conversation_id: 'synthetic-session', requested_model: config.worker.model, observed_model: config.worker.model });
  const worker = { async tools() { return ['antigravity_execute','antigravity_continue','antigravity_result']; },
    async execute(_task, prompt, op) { assert.match(prompt, /controller runs all tests/); assert.doesNotMatch(prompt, /run the relevant tests/); calls.push('execute'); await writeFile(path.join(workspace, 'old.txt'), 'after\n'); await writeFile(path.join(workspace, 'new.txt'), 'created\n\n'); return result(op); },
    async continue(_task, prompt, op) { calls.push('continue'); assert.match(prompt, /Do not read\/run gates/); await writeFile(path.join(workspace, 'new.txt'), 'created\n'); return result(op); } };
  let reviews = 0;
  const final = await runBounded({ taskPath: fakePath, packetDir: m.packetDir, config: fakeConfig, worker,
    reviewerInvoker: async () => { assert.equal(await readFile(settings, 'utf8'), settingsBytes); reviews++; return { code: 0, session_id: `synthetic-review-${reviews}`, observed_models: [config.reviewer.model], result: { verdict: reviews === 1 ? 'NEEDS_FIX' : 'PASS', summary: 'fixture', material_findings: reviews === 1 ? ['check content'] : [], risk_checks_completed: true } }; } });
  assert.equal(final.status, 'WAITING_FOR_CHECKPOINT'); assert.deepEqual(calls, ['execute', 'continue']); assert.equal(reviews, 2);
  assert.equal(await readFile(settings, 'utf8'), settingsBytes);
  const statePath = path.join(m.packetDir, 'state.json');
  const waiting = JSON.parse(await readFile(statePath, 'utf8'));
  waiting.status = 'PRODUCT_CHECK_WAIT'; waiting.phase = 'PRODUCT_CHECK_WAIT';
  await writeFile(statePath, JSON.stringify(waiting, null, 2) + '\n');
  let verificationCalls = 0;
  const verified = await verifyProductDirect(manifest, undefined, {
    async claimTask() { return { status: 'ALREADY_CLAIMED' }; },
    async verifyProductCheck() { verificationCalls++; return { status: 'WAITING_FOR_CHECKPOINT', task_id: task.task_id, product_check: { status: 'PASS' } }; }
  });
  assert.deepEqual(verified, { status: 'WAITING_FOR_CHECKPOINT', task_id: task.task_id, product_check: 'PASS', provider_invocations: 0 });
  assert.equal(verificationCalls, 1);
});

test('prepareDirect and checkDirect reject former Gemini reviewer, incorrect Luna model/effort bindings, and fallback reviewer', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-reviewer-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), output = path.join(root, 'packet'), worktrees = path.join(root, 'worktrees');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Direct test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, '.gitignore'), '.workflow-local/\n');
  await writeFile(path.join(repo, 'file.txt'), 'hello\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const task = { schema_version: 'qq.workflow.task.v10.1', task_id: 'TASK-REVIEWER-CHECK', revision: 1, base_sha: git('rev-parse', 'HEAD'), goal: 'validate reviewer', acceptance_criteria: ['reject bad reviewer'],
    gates: [{ id: 'noop', argv: [process.execPath, '-p', '1'], timeout_seconds: 20 }], user_visible: false, risk: 'LOW', complexity: 'SIMPLE', execution: { policy: 'CONTROLLED_DELEGATION_V1' },
    write_paths: ['file.txt'], allowed_paths: ['file.txt'], lane: 'NORMAL', initial_lane: 'NORMAL', initial_risk: 'LOW', product_check: { applicable: false, reason: 'fixture' }, candidate_head: null, contract_sha256: null };
  const validConfig = { schema_version: 'qq.bridge.v2', billing: 'SUBSCRIPTION_ONLY', mode: 'ASSISTED', timeout_seconds: 30, write_paths: task.write_paths, gate_paths: [],
    worker: { transport: 'mcp', server: 'antigravity_worker', provider: 'mcp', command: ['python', 'mcp/antigravity_server.py'], model: 'gemini-3.8-flash-high', local_trial: true, local_trial_root: worktrees, skip_permissions: false },
    reviewer: { provider: 'openai', cli: 'codex', command: ['codex'], model: 'gpt-5.6-luna', effort: 'max' } };

  const formerGemini = { provider: 'google', cli: 'antigravity', command: ['agy'], model: 'gemini-3.8-flash-high', agent: 'ag-reviewer-011-r1', agent_definition_sha256: 'ef23a4c0616a77d1d5b982c02ea07ec281c00de5d86aaa42523714b0678bdaea' };

  const invalidReviewers = [formerGemini, { ...validConfig.reviewer, model: 'gpt-5.6-terra' },
    { ...validConfig.reviewer, effort: 'high' }, { ...validConfig.reviewer, provider: 'google' },
    { ...validConfig.reviewer, cli: 'antigravity' }];
  for (const [index, reviewer] of invalidReviewers.entries()) {
    await assert.rejects(prepareDirect(repo, task, { ...validConfig, reviewer }, path.join(root, `out-${index}`)), /LUNA_REVIEWER_REQUIRED/);
  }
  await assert.rejects(prepareDirect(repo, task, { ...validConfig, fallback_reviewer: { provider: 'openai', cli: 'codex', command: ['codex'], model: 'gpt-5.6-terra', effort: 'high' } }, path.join(root, 'out-fallback')), /FALLBACK_REQUIRES_SEPARATE_DECISION/);

  const m = await prepareDirect(repo, task, validConfig, output);
  const preparedConfig = JSON.parse(await readFile(m.configPath));
  const testCheckDirectRejection = async (badReviewer, badFallback, expectedCode) => {
    const testConfig = structuredClone(preparedConfig);
    if (badReviewer) testConfig.reviewer = badReviewer;
    if (badFallback) testConfig.fallback_reviewer = badFallback;
    const testRoot = path.join(path.dirname(m.taskPath), `chk-${Math.random().toString(36).slice(2)}`);
    await mkdir(testRoot, { recursive: true });
    const taskPath = path.join(testRoot, `${task.task_id}.json`);
    const configPath = path.join(testRoot, 'config.json');
    const preparedPath = path.join(testRoot, 'prepared.json');
    const clonedTask = structuredClone(task);
    await writeFile(taskPath, JSON.stringify(clonedTask));
    await freezeControlledTask(taskPath, clonedTask, testConfig);
    await writeFile(configPath, JSON.stringify(testConfig));
    await writeFile(preparedPath, JSON.stringify({ repo, taskPath, configPath, packetDir: path.join(testRoot, 'packet'), helper_sha256: m.helper_sha256 }));
    await assert.rejects(checkDirect(preparedPath), new RegExp(expectedCode));
  };

  await testCheckDirectRejection(formerGemini, undefined, 'LUNA_REVIEWER_REQUIRED');
  await testCheckDirectRejection({ ...validConfig.reviewer, model: 'gpt-5.6-terra' }, undefined, 'LUNA_REVIEWER_REQUIRED');
  await testCheckDirectRejection({ ...validConfig.reviewer, effort: 'high' }, undefined, 'LUNA_REVIEWER_REQUIRED');
  await testCheckDirectRejection(undefined, { provider: 'openai', cli: 'codex', command: ['codex'], model: 'gpt-5.6-terra', effort: 'high' }, 'FALLBACK_REQUIRES_SEPARATE_DECISION');
});
