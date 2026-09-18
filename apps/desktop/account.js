'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

// The main process owns the exchange verifier and OS-sealed account credential.
class DesktopAccount {
  constructor({ origin, dataDir, safeStorage, openExternal, fetch: request = fetch }) {
    if (new URL(origin).protocol !== 'https:') throw new Error('secure_service_required');
    this.origin = origin; this.file = path.join(dataDir, 'account-session');
    this.storage = safeStorage; this.openExternal = openExternal; this.request = request;
    this.pending = null;
  }
  requireProtection() {
    if (!this.storage.isEncryptionAvailable() || this.storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('os_key_protection_unavailable');
  }
  saved() {
    this.requireProtection();
    if (!fs.existsSync(this.file)) return null;
    return this.storage.decryptString(fs.readFileSync(this.file));
  }
  async api(route, body, token) {
    const response = await this.request(this.origin + '/api/auth/' + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'sign_in_unavailable'), { status: response.status });
    return data;
  }
  async session() {
    const token = this.saved();
    if (!token) return null;
    try { await this.api('session', undefined, token); return token; }
    catch (error) { if (error.status !== 401) throw error; fs.rmSync(this.file, { force: true }); return null; }
  }
  async start() {
    this.requireProtection();
    const verifier = randomBytes(32).toString('base64url');
    const device = await this.api('desktop/start', { challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (!/^[A-Za-z0-9_-]{43}$/.test(device.id) || !/^[A-F0-9]{8}$/.test(device.code)) throw new Error('invalid_sign_in_response');
    this.pending = { id: device.id, verifier, expires: Date.now() + 600000 };
    // Construct locally: a service response cannot make the desktop open another origin.
    await this.openExternal(this.origin + '/connect/' + device.id);
    return { code: device.code };
  }
  async poll() {
    const pending = this.pending;
    if (!pending || pending.expires <= Date.now()) throw new Error('desktop_sign_in_expired');
    const result = await this.api('desktop/exchange', { id: pending.id, verifier: pending.verifier });
    if (result.pending) return null;
    if (this.pending !== pending || !/^ps_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error('invalid_sign_in_response');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, this.storage.encryptString(result.token), { mode: 0o600 });
    this.pending = null;
    return result.token;
  }
  async logout() {
    const token = this.saved();
    if (token) await this.api('logout', {}, token);
    fs.rmSync(this.file, { force: true }); this.pending = null;
  }
}
module.exports = { DesktopAccount };
