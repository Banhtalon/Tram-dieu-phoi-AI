// A gate may emit a structured verdict in JSON. A successful exit must not
// override an explicit non-PASS verdict; legacy text-only gates use exit code.
const KNOWN_STATUSES = new Set(['PASS', 'FAIL', 'ERROR', 'BLOCKED', 'SKIPPED', 'UNVERIFIED']);

export function reportedGateStatus(stdout) {
  let value;
  try { value = JSON.parse(String(stdout ?? '').trim()); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, 'status')) return null;
  return KNOWN_STATUSES.has(value.status) ? value.status : 'NON_PASS';
}

export function gatePassed(result) {
  const status = reportedGateStatus(result?.stdout);
  return result?.code === 0 && result.timed_out !== true && result.interrupted !== true &&
    (status === null || status === 'PASS');
}

export function contradictoryGate(tests) {
  if (!Array.isArray(tests)) return null;
  return tests.find(test => test?.code === 0 && test.timed_out !== true && test.interrupted !== true &&
    reportedGateStatus(test.stdout) !== null && reportedGateStatus(test.stdout) !== 'PASS') ?? null;
}
