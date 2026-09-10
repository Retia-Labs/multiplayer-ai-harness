'use strict';
// Supported seven-day ciphertext snapshots. Restore requires the CURRENT authority
// database and never imports membership, credentials, grants or recovery material.
const fs = require('node:fs');
const path = require('node:path');
const { HubStore } = require('../packages/hub/store');
const { Enrollment } = require('../packages/hub/enrollment');
const { KeyExchange } = require('../packages/hub/key-exchange');
const { EncryptedTasks } = require('../packages/hub/encrypted-tasks');
const { Retention } = require('../packages/hub/retention');
const [operation, database, snapshotName] = process.argv.slice(2);
let store;
try {
  if (!['create', 'restore', 'prune'].includes(operation) || !database || !fs.existsSync(database)) throw new Error('usage');
  store = new HubStore(database);
  const enrollment = new Enrollment(store);
  new KeyExchange(store); new EncryptedTasks(store, enrollment);
  const retention = new Retention(store, { dbFile: database }); store.retention = retention;
  if (operation === 'create') {
    const snapshot = retention.snapshot();
    fs.mkdirSync(retention.backupDir, { recursive: true });
    const name = 'snapshot-' + snapshot.createdAt + '.json';
    const target = path.join(retention.backupDir, name);
    fs.writeFileSync(target, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ snapshot: name, expiresAt: snapshot.expiresAt }));
  } else if (operation === 'restore') {
    if (!/^snapshot-\d+\.json$/.test(snapshotName || '')) throw new Error('usage');
    const target = path.join(retention.backupDir, snapshotName);
    if (!fs.lstatSync(target).isFile()) throw new Error('usage');
    console.log(JSON.stringify(retention.restore(JSON.parse(fs.readFileSync(target, 'utf8')))));
  } else { retention.pruneBackups(); console.log(JSON.stringify({ pruned: true })); }
} catch (error) {
  console.error(error.code || 'Usage: node scripts/service-backup.js create|prune <existing-current-hub.sqlite> OR restore <existing-current-hub.sqlite> <snapshot-name.json>');
  process.exitCode = 1;
} finally { store?.close(); }
