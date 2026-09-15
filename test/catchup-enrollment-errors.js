'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Test presentation/error precedence at the public client seam. The real SDK and
// authenticated replay remain covered by the browser mailbox/enrollment suites.
function fixture({ waiting, replayError } = {}) {
  const writes = new Map(), calls = { replay: 0, recovery: 0 };
  const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: (key, value) => writes.set(key, value) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/web/encrypted.js'), 'utf8'), sandbox);
  const client = Object.create(sandbox.window.PlexusEncrypted.EncryptedClient.prototype);
  Object.assign(client, {
    userId: 'owner', teamId: 'team', receipts: new Map(), endpoint: {}, tasks: {},
    confirmedHost: () => ({ user: 'host', device: 'device' }),
    receiveKeys: async () => ({ waiting, pending: 1 }),
    requestHistory: async () => { calls.recovery++; return { state: 'requested' }; },
    storageKey: (prefix, id) => prefix + id,
    m: {
      EncryptedTaskReader: class {
        seq = 0;
        async reconnect() {
          calls.replay++;
          if (replayError) throw Object.assign(new Error(replayError), { code: replayError });
          this.seq = 1; return { title: 'Restored history', receipts: [] };
        }
        checkpoint() { return { seq: 1, hash: 'verified' }; }
      },
      catchUp: snapshot => ({ title: snapshot.title })
    }
  });
  return { client, calls, writes, task: { id: 'task', runtimeId: 'runtime', projectId: 'project' } };
}

test('readable restored history still replays while membership delivery is waiting', async () => {
  const f = fixture({ waiting: 'membership_authority_required' });
  const result = await f.client.catchUp(f.task);
  assert.equal(result.error, undefined);
  assert.equal(result.snapshot.title, 'Restored history');
  assert.equal(f.calls.replay, 1);
  assert.equal(f.calls.recovery, 0);
  assert.equal(f.writes.size, 1);
});

test('undeliverable history names enrollment and avoids a futile new handoff', async () => {
  const f = fixture({ waiting: 'membership_authority_required', replayError: 'task_integrity_failed' });
  const result = await f.client.catchUp(f.task);
  assert.equal(result.error, 'membership_authority_required');
  assert.equal(result.pending, 1);
  assert.equal(f.calls.replay, 1);
  assert.equal(f.calls.recovery, 0);
  assert.equal(f.writes.size, 0);
});

test('integrity failure without a waiting mailbox remains an integrity failure', async () => {
  const f = fixture({ replayError: 'task_integrity_failed' });
  const result = await f.client.catchUp(f.task);
  assert.equal(result.error, 'task_integrity_failed');
  assert.equal(result.historyRecovery.state, 'requested');
  assert.equal(f.writes.size, 0);
});

test('membership waiting cannot replace rollback evidence', async () => {
  const f = fixture({ waiting: 'membership_authority_required', replayError: 'history_rollback' });
  const result = await f.client.catchUp(f.task);
  assert.equal(result.error, 'history_rollback');
  assert.equal(f.calls.recovery, 0);
  assert.equal(f.writes.size, 0);
});
