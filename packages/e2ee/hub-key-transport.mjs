// An endpoint's binding to the real hub's key routes.
//
// The same shape as the spike's HttpKeyTransport, pointed at /api/e2ee on the hub the rest
// of the product already talks to, and authenticating the way everything else does: an
// account bearer token, or a runtime credential for an execution host.
export class HubKeyTransport {
  constructor({ url, token, device, runtimeId = null }) {
    this.url = url; this.token = token; this.device = device; this.runtimeId = runtimeId;
  }
  async request(route, value = {}) {
    const response = await fetch(this.url + '/api/e2ee/' + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.token,
        ...(this.runtimeId ? { 'X-Plexus-Runtime': this.runtimeId } : {})
      },
      body: JSON.stringify({ device: this.device, ...value }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      let code = 'key_request_refused';
      try { code = (await response.json()).error || code; } catch {}
      throw new Error(code);
    }
    return response.json();
  }
  // The SDK hands us its own request bodies; they go through unread.
  async send(type, { user, device, body }) { return JSON.stringify(await this.request('keys', { type, user, device, body })); }
  deliverToDevice(user, device, envelope, taskId) { return this.request('deliver', { user, device, envelope, ...(taskId ? { taskId } : {}) }); }
  drain() { return this.request('drain'); }
}
