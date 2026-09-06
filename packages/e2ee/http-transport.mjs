export class HttpKeyTransport {
  constructor({ url, token }) { this.url = url; this.token = token; }
  async request(route, value = {}) {
    const response = await fetch(this.url + '/e2ee/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('relay_' + response.status);
    return response.json();
  }
  async send(type, metadata) { return JSON.stringify(await this.request('keys', { type, ...metadata })); }
  deliverToDevice(user, device, envelope) { return this.request('deliver', { user, device, envelope }); }
  drain() { return this.request('drain'); }
  putTask(room, event) { return this.request('task', { room, event }); }
  tasks(room) { return this.request('history', { room }); }
  backup(id, ciphertext) { return this.request('backup', { id, ciphertext }); }
  restore(id) { return this.request('restore', { id }); }
}
