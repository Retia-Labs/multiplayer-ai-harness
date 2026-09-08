'use strict';
// Browser and execution-host stores use separate keys with the same OS protection rules.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { safeStorage } = require('electron');

function protectedStoreKey(dataDir, purpose) {
  if (!/^[a-z-]+$/.test(purpose)) throw new Error('invalid_key_purpose');
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('os_key_protection_unavailable');
  }
  const file = path.join(dataDir, purpose + '-store-key');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let secret;
  try {
    if (fs.existsSync(file)) secret = safeStorage.decryptString(fs.readFileSync(file));
    else {
      secret = randomBytes(32).toString('base64');
      fs.writeFileSync(file, safeStorage.encryptString(secret), { mode: 0o600, flag: 'wx' });
    }
  } catch { throw new Error('crypto_storage_locked_or_corrupt'); }
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw new Error('crypto_storage_corrupt');
  return [...key];
}

module.exports = { protectedStoreKey };
