'use strict';
const { StringDecoder } = require('node:string_decoder');

// Errors crossing the adapter boundary are fixed codes, never provider stderr,
// JSON-RPC error messages, account details, or credential-bearing config text.
class CodexProviderError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const failure = (code) => new CodexProviderError(code);
function providerFailure(error) {
  const info = error?.codexErrorInfo;
  if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(info)) return failure('codex_usage_limit');
  if (error?.code === -32601 || error?.code === -32602) return failure('codex_protocol_unsupported');
  return failure('codex_request_failed');
}

class CodexRpc {
  constructor(child, { timeoutMs = 30000, maxFrameBytes = 1024 * 1024, onNotification = () => {}, onRequest = () => {} } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.pending = new Map();
    this.nextId = 1;
    this.error = null;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    child.stdout.on('data', (data) => this.receive(data));
    // Drain stderr, but never retain or forward its potentially sensitive text.
    child.stderr.on('data', () => {});
    child.on('error', () => this.fail('codex_unavailable'));
    child.on('close', () => this.fail('codex_disconnected'));
    child.stdin.on('error', () => this.fail('codex_disconnected'));
    child.stdout.on('error', () => this.fail('codex_disconnected'));
    child.stderr.on('error', () => this.fail('codex_disconnected'));
  }
  fail(code) {
    if (this.error) return;
    this.error = failure(code);
    this.buffer = '';
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.error); }
    this.pending.clear();
    this.resolveClosed(this.error);
  }
  send(message) {
    if (this.error) throw this.error;
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw failure('codex_frame_too_large');
    try { this.child.stdin.write(frame, (err) => { if (err) this.fail('codex_disconnected'); }); }
    catch { this.fail('codex_disconnected'); throw this.error; }
  }
  call(method, params) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail('codex_request_timeout'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) { this.send({ method, params }); }
  reply(id, result) { this.send({ id, result }); }
  refuse(id) { this.send({ id, error: { code: -32601, message: 'Unsupported client request' } }); }
  receive(data) {
    if (this.error) return;
    this.buffer += this.decoder.write(data);
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) return this.fail('codex_frame_too_large');
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { return this.fail('codex_protocol_invalid'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail('codex_protocol_invalid');
      try {
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) {
            Promise.resolve(this.onRequest(message)).catch(() => this.fail('codex_client_request_failed'));
          } else this.onNotification(message);
        } else if (this.pending.has(message.id)) {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error) entry.reject(providerFailure(message.error));
          else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
          else { entry.reject(failure('codex_protocol_invalid')); this.fail('codex_protocol_invalid'); }
        }
      } catch { return this.fail('codex_protocol_invalid'); }
      if (this.error) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) this.fail('codex_frame_too_large');
  }
  close() {
    this.fail('codex_closed');
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

module.exports = { CodexRpc, CodexProviderError, providerFailure, failure };
