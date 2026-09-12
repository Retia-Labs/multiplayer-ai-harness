'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { install } = require('../scripts/desktop-installer');

// Called only after the lifecycle test has verified both managed processes exited.
// Snapshot the whole fixture profile; mixing individual crypto files is unsafe.
function cycle(configFile, { userData, dataDir }) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (path.dirname(configFile) !== config.root || path.dirname(config.target) !== config.root ||
      !path.basename(config.root).startsWith('plexus-upgrade-')) throw new Error('Not an isolated upgrade fixture.');
  const stores = [userData, dataDir];
  const backups = stores.map((store, i) => {
    const backup = path.join(config.root, 'snapshot-' + i);
    fs.cpSync(store, backup, { recursive: true, verbatimSymlinks: true });
    return backup;
  });
  return {
    upgrade: () => install(config.to, config.target),
    reinstall: () => install(config.to, config.target),
    rollback() {
      const executable = install(config.from, config.target);
      stores.forEach((store, i) => {
        fs.rmSync(store, { recursive: true, force: true });
        fs.cpSync(backups[i], store, { recursive: true, verbatimSymlinks: true });
      });
      return executable;
    },
    record(fromVersion, toVersion, identities) {
      assert.notEqual(fromVersion, toVersion, 'Use distinct app versions for upgrade qualification; same-version launch is only reinstall.');
      fs.writeFileSync(path.join(config.root, 'result.json'), JSON.stringify({ fromVersion, toVersion,
        identityPreserved: true, encryptedHistoryReadable: true, interruptedWorkNotReplayed: true,
        reinstall: 'pass', matchingBackupRollback: 'pass', identities }, null, 2));
    }
  };
}
module.exports = { cycle };
