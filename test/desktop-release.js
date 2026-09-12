'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.resolve(__dirname, '../scripts/desktop-release.js');
function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CSC_') && !key.startsWith('APPLE_') && key !== 'PLEXUS_WINDOWS_CERT_SHA1'));
}
function check(env, args = ['--check']) {
  return spawnSync(process.execPath, [command, ...args], { env, encoding: 'utf8' });
}
test('the release command refuses absent signing credentials before building', () => {
  const result = check(environment());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE BLOCKED/);
  assert.doesNotMatch(result.stdout, /Verified signing|Release configuration is present/);
});
test('disabling automatic signing cannot silently produce a release', () => {
  const result = check({ ...environment(), CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Signing is disabled|Build on macOS or Windows/);
});
test('an internal-build switch cannot bypass release qualification', () => {
  const result = check(environment(), ['--unsigned']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});
test('a configured Mac identity without notarization is refused without exposing its value', { skip: process.platform !== 'darwin' }, () => {
  const result = check({ ...environment(), CSC_NAME: 'synthetic-private-identity-canary' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Configure notarization/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-identity-canary/);
});
