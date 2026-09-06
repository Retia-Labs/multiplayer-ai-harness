'use strict';
// Reconnecting WebSocket client used by the runtime to talk to the hub.
const EventEmitter = require('events');

class HubClient extends EventEmitter {
  constructor({ url, hello, log = () => {} }) {
    super();
    this.url = url;
    this.hello = hello;      // hello payload (role, name/token, runtime descriptor)
    this.log = log;
    this.ws = null;
    this.closed = false;
    this.backoff = 500;
    this.queue = [];         // messages buffered while disconnected
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 500;
      ws.send(JSON.stringify({ type: 'hello', ...this.hello }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'welcome') {
        this.welcome = msg;
        if (msg.user && msg.user.token) this.hello.token = msg.user.token;
        this.emit('welcome', msg);
        for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      }
      this.emit('message', msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.welcome = null;
      }
      this.emit('disconnect');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 8000);
      }
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1 && this.welcome) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  reconnect() {
    this.welcome = null;
    if (this.ws) this.ws.close();
    else this.connect();
  }

  close() {
    this.closed = true;
    if (this.ws) { try { this.ws.close(); } catch {} }
  }
}

module.exports = { HubClient };
