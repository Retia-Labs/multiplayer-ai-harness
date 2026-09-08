'use strict';
// Runtime-side proxy for the SDK store owned by the bundled desktop crypto renderer.
const { randomBytes } = require('node:crypto');
const METHODS = ['track', 'peerEndpoints', 'confirmEndpoint', 'isEndpointVerified', 'sealControl', 'openControl', 'open',
  'shareVerifiedTaskKey', 'encryptTask', 'decryptVerifiedTask', 'rotateTaskKey', 'exportHistory', 'importHistory', 'sign'];
function endpointChannel(channel = process) {
  if (typeof channel.send !== 'function') throw new Error('durable_crypto_broker_required');
  const pending = new Map();
  let disconnected = false;
  const disconnect = () => {
    disconnected = true;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('crypto_broker_closed')); }
    pending.clear();
  };
  channel.on('disconnect', disconnect);
  channel.on('exit', disconnect);
  const receive = (message) => {
    if (message?.type !== 'crypto.response') return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(Object.assign(new Error(message.error), { code: message.error }));
    else call.resolve(message.result);
  };
  channel.on('message', receive);
  const request = (operation, args) => new Promise((resolve, reject) => {
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('crypto_broker_unavailable')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    if (disconnected || channel.connected === false) { clearTimeout(timer); pending.delete(id); reject(new Error('crypto_broker_closed')); return; }
    try { channel.send({ type: 'crypto.request', id, operation, args }, (error) => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('crypto_broker_closed')); }
    }); } catch { clearTimeout(timer); pending.delete(id); reject(new Error('crypto_broker_closed')); }
  });
  request.close = () => {
    channel.off('message', receive);
    channel.off('disconnect', disconnect);
    channel.off('exit', disconnect);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('crypto_broker_closed')); }
    pending.clear();
  };
  return request;
}
async function createDurableEndpoint(options, { request = endpointChannel() } = {}) {
  const transport = options.transport;
  const identity = await request('create', [{ user: options.user, device: options.device,
    transport: { url: transport.url, token: transport.token, device: transport.device, runtimeId: transport.runtimeId } }]);
  let closing;
  const endpoint = { user: options.user, device: options.device, transport, identity: () => ({ ...identity }),
    close: () => (closing ||= request('close', []).finally(() => request.close?.())) };
  for (const method of METHODS) endpoint[method] = (...args) => request(method, args.map((arg) =>
    arg && arg.admittedSessions instanceof Set ? { ...arg, admittedSessions: [...arg.admittedSessions] } : arg));
  return endpoint;
}
module.exports = { createDurableEndpoint, endpointChannel };
