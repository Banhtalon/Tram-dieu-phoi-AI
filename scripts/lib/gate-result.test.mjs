import assert from 'node:assert/strict';
import test from 'node:test';
import { reportedGateStatus, gatePassed, contradictoryGate } from './gate-result.mjs';

test('legacy plain-text or status-free JSON gates retain exit-code behavior', () => {
  assert.equal(reportedGateStatus('normal test output'), null);
  assert.equal(gatePassed({ code: 0, stdout: 'normal test output' }), true);
  assert.equal(gatePassed({ code: 0, stdout: '{"count": 1}' }), true);
  assert.equal(gatePassed({ code: 1, stdout: 'normal test output' }), false);
});

test('an explicit FAIL cannot pass with process exit 0', () => {
  const bad = { id: 'logic', code: 0, stdout: '{"status":"FAIL"}' };
  assert.equal(gatePassed(bad), false);
  assert.deepEqual(contradictoryGate([{ id: 'ok', code: 0, stdout: '{"status":"PASS"}' }, bad]), bad);
});

test('unknown or malformed structured statuses fail closed without leaking raw values', () => {
  assert.equal(reportedGateStatus('{"status":"SECRET-LIKE-UNEXPECTED"}'), 'NON_PASS');
  assert.equal(gatePassed({ code: 0, stdout: '{"status":"SUCCESS"}' }), false);
  assert.equal(gatePassed({ code: 0, stdout: '{"status":false}' }), false);
  assert.equal(reportedGateStatus('{"status":"FAIL"'), null);
});

test('timeouts, interruptions and nonzero exits never pass', () => {
  for (const result of [{ code: 0, timed_out: true, stdout: '{"status":"PASS"}' },
    { code: 0, interrupted: true, stdout: '{"status":"PASS"}' },
    { code: 2, stdout: '{"status":"PASS"}' }]) assert.equal(gatePassed(result), false);
});

test('contradictoryGate only signals false positives, not regular nonzero failures', () => {
  assert.equal(contradictoryGate([]), null);
  assert.equal(contradictoryGate([{ code: 1, stdout: '{"status":"FAIL"}' }]), null);
  assert.equal(contradictoryGate([{ code: 0, stdout: '{"status":"PASS"}' }]), null);
});
