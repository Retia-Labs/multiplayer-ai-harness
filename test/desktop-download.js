'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Hub } = require('../packages/hub/server');
const { DesktopDownload } = require('../packages/hub/desktop-download');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = 'Plexus-0.2.0-alpha.1-mac-arm64-unnotarized.dmg', bytes = Buffer.from('fixture installer');
  const release = { version: '0.2.0-alpha.1', platform: 'darwin', arch: 'arm64', signing: 'no-verified-publisher', notarization: 'not-performed', commit: 'a'.repeat(40),
    artifacts: [{ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  fs.writeFileSync(path.join(dir, file), bytes);
  const save = () => fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release)); save();
  return { dir, file, bytes, release, save };
}
test('download is account-gated and serves only the configured checksummed artifact', async t => {
  const f = fixture(t), hub = new Hub({ desktopReleaseDir: f.dir });
  const address = await hub.listen(); t.after(() => hub.close());
  const url = 'http://127.0.0.1:' + address.port;
  const user = hub.store.createAccount('Owner'); const headers = { authorization: 'Bearer ' + user.token };
  for (const route of ['/api/desktop-release', '/api/desktop-download']) assert.equal((await fetch(url + route)).status, 401);
  const metadata = await (await fetch(url + '/api/desktop-release', { headers })).json();
  assert.equal(metadata.sha256, f.release.artifacts[0].sha256); assert.equal(metadata.notarization, 'not-performed');
  assert.equal(JSON.stringify(metadata).includes(f.dir), false);
  const response = await fetch(url + metadata.url + '?file=../../secret', { headers });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /unnotarized.dmg/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  const head = await fetch(url + metadata.url, { headers, method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(f.bytes.length)); assert.equal(await head.text(), '');
  assert.equal((await fetch(url + metadata.url, { headers, method: 'POST' })).status, 405);
});
test('release registration fails for mismatched bytes, misleading labels and escaping paths', t => {
  const f = fixture(t);
  f.release.artifacts[0].sha256 = '0'.repeat(64); f.save();
  assert.throws(() => new DesktopDownload(f.dir), /checksum_mismatch/);
  f.release.notarization = 'verified'; f.save(); assert.throws(() => new DesktopDownload(f.dir), /invalid_desktop_release/);
  f.release.notarization = 'not-performed'; f.release.artifacts[0].file = '../secret.dmg'; f.save();
  assert.throws(() => new DesktopDownload(f.dir), /invalid_desktop_release/);
});
test('an unconfigured service reports no available installer', async t => {
  const hub = new Hub(); const address = await hub.listen(); t.after(() => hub.close());
  const user = hub.store.createAccount('Owner'), headers = { authorization: 'Bearer ' + user.token };
  const url = 'http://127.0.0.1:' + address.port;
  assert.deepEqual(await (await fetch(url + '/api/desktop-release', { headers })).json(), { available: false });
  assert.equal((await fetch(url + '/api/desktop-download', { headers })).status, 404);
});

test('hosted downloads accept a live cookie but reject legacy, URL and revoked tokens', async t => {
  const f = fixture(t), hub = new Hub({ desktopReleaseDir: f.dir, auth: {
    origin: 'https://app.tryplexus.dev', clientId: 'fixture', clientSecret: 'fixture', allowedIds: ['42']
  } });
  const address = await hub.listen(); t.after(() => hub.close());
  const user = hub.store.createAccount('Owner');
  hub.store.db.prepare('INSERT INTO account_identities VALUES (?,?,?,?,?)').run('github', '42', user.id, 'owner', 'owner@example.test');
  const token = hub.auth.session(user.id), url = 'http://127.0.0.1:' + address.port + '/api/desktop-download';
  const cookie = { cookie: '__Host-plexus-session=' + token };
  const response = await fetch(url, { headers: cookie });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + user.token } })).status, 401);
  assert.equal((await fetch(url + '?token=' + token)).status, 401);
  hub.store.db.prepare('DELETE FROM account_sessions').run();
  assert.equal((await fetch(url, { headers: cookie })).status, 401);
});
