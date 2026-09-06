// Versioned wire contract. Content never belongs in this module's routing fields.
export const VERSION = 1;
export const TASK_ID = /^et_[a-f0-9]{32}$/;
export const PROJECT_ID = /^ep_[a-f0-9]{32}$/;
export const EVENT_ID = /^ev_[a-f0-9]{32}$/;
export const roomFor = (id) => '!' + id + ':plexus.local';
export const matrixUser = (id) => '@' + id + ':plexus.local';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_record');
  return encoded;
}
export function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const base64 = (value, max = 1400000) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
export function validRequest(event, sender) {
  if (!exact(event, ['type','sender','content']) || event.type !== 'm.room.encrypted' || event.sender !== sender) return false;
  const c = event.content;
  if (!exact(c, ['algorithm','sender_key','ciphertext',...(Object.hasOwn(c || {},'org.matrix.msgid')?['org.matrix.msgid']:[])]) ||
      (Object.hasOwn(c,'org.matrix.msgid') && !/^[a-f0-9]{32}$/.test(c['org.matrix.msgid'])) ||
      c.algorithm !== 'm.olm.v1.curve25519-aes-sha2' || !base64(c.sender_key, 64)) return false;
  const entries = Object.entries(c.ciphertext || {});
  return entries.length === 1 && entries.every(([key, part]) => base64(key,64) &&
    exact(part,['type','body']) && [0,1].includes(part.type) && base64(part.body));
}
export function validRecord(record, task) {
  if (!exact(record,['version','id','seq','envelope']) || record.version !== VERSION ||
      !EVENT_ID.test(record.id) || !integer(record.seq) || record.seq < 1) return false;
  const e = record.envelope;
  if (!exact(e,['type','sender','room_id','content']) || e.type !== 'm.room.encrypted' ||
      e.sender !== matrixUser(task.runtimeId) || e.room_id !== roomFor(task.id)) return false;
  const c=e.content;
  return exact(c,['algorithm','ciphertext','sender_key','session_id','device_id']) &&
    c.algorithm === 'm.megolm.v1.aes-sha2' && base64(c.ciphertext) &&
    base64(c.sender_key,64) && base64(c.session_id,64) && typeof c.device_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.device_id);
}
export async function digest(record) {
  const bytes = new TextEncoder().encode(canonical(record));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),(v)=>v.toString(16).padStart(2,'0')).join('');
}
