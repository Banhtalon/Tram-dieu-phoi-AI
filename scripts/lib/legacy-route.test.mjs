import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const command of ['pilot', 'run', 'quota-drill', 'activate']) {
  test(`legacy ${command} cannot start a new route`, () => {
    const result = spawnSync(process.execPath, ['scripts/bridge.mjs', command], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LEGACY_NEW_DISPATCH_DISABLED/);
  });
}
