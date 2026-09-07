'use strict';
// The execution host's encrypted side, in production rather than in a fixture.
//
// #6 built the log and drove it from test code; nothing in the shipped runtime ever opened
// an encrypted task. This is that path: the host publishes an endpoint through the hub,
// finds the tasks addressed to it, opens the ones whose creator it can verify, and writes a
// real turn into the log.
//
// Three things it refuses to guess:
//
//   * **Whose request to open.** Only an endpoint the team has confirmed through #8's
//     enrolment. The host reads those verdicts from the hub; it never makes them.
//   * **Where a project lives.** An opaque project id means nothing until an operator maps
//     it to a directory on this machine. Without a mapping the task is left alone, because
//     the alternative is a remote id selecting a local folder.
//   * **What the agent did.** Turn events are translated, never summarised, and anything
//     without a counterpart in the log is dropped rather than approximated.
const { Endpoint } = require('../e2ee/endpoint');
const { HubKeyTransport } = require('../e2ee/hub-key-transport.mjs');
const { EncryptedTaskTransport } = require('../e2ee/task-log.mjs');
const { matrixUser } = require('../protocol/encrypted-task.mjs');
const { EncryptedTaskState, EncryptedFixtureHost } = require('./encrypted-task');
const { EncryptedTaskRun } = require('./encrypted-run');

class EncryptedHost {
  constructor({ runtime, url, statePath, projects = new Map(), device = 'HOST', log = () => {} }) {
    this.runtime = runtime;
    this.url = url;                 // http origin of the hub
    this.statePath = statePath;     // durable outbox + checkpoints
    this.projects = projects;       // opaque projectId -> authorized local directory
    this.device = device;
    this.log = log;
    this.endpoint = null;
    this.adapter = null;
    this.state = null;
    this.handled = new Set();
    this.running = new Map();
  }

  // The host's identity lives only as long as this process. That is recorded rather than
  // worked around: the SDK's persistent store is IndexedDB-backed, so a Node runtime cannot
  // hold one, and a durable identity means running the endpoint where a browser store
  // exists. Until then a restart means this host can no longer read what it wrote.
  static identityDurability() {
    return { persistent: false, reason: 'the crypto store is IndexedDB-backed and Node has no IndexedDB' };
  }

  async start() {
    if (!this.runtime.teamId) throw new Error('runtime_unpaired');
    this.state = new EncryptedTaskState(this.statePath);
    this.endpoint = await Endpoint.create({
      user: matrixUser(this.runtime.id),
      device: this.device,
      transport: new HubKeyTransport({ url: this.url, token: this.runtime.runtimeToken, device: this.device, runtimeId: this.runtime.id })
    });
    this.tasks = new EncryptedTaskTransport({ url: this.url, token: this.runtime.runtimeToken, runtimeId: this.runtime.id });
    this.log('encrypted host endpoint published as ' + this.endpoint.identity().device);
    return this.endpoint.identity();
  }

  // Verified endpoints in this team, as the hub records them. A creator whose endpoint is
  // only announced - not confirmed by anybody - is not somebody this host will act for.
  async verifiedEndpoints() {
    const response = await fetch(this.url + '/api/enrollment?team=' + encodeURIComponent(this.runtime.teamId), {
      headers: { Authorization: 'Bearer ' + this.runtime.runtimeToken, 'X-Plexus-Runtime': this.runtime.id },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('enrollment_unavailable');
    const state = await response.json();
    const out = new Map();
    for (const row of state.endpoints || []) {
      if (row.state !== 'verified') continue;
      const identity = { user: matrixUser(row.userId), device: row.device, curve25519: row.curve25519, ed25519: row.ed25519 };
      // The team's verdict is the trust decision; this records it in the host's own crypto
      // store so the SDK will treat that device's envelopes as authenticated. The host is
      // honouring a confirmation somebody else made, which is why it never sets one of its
      // own - and why a key that does not match the one the team confirmed is dropped rather
      // than trusted: the enrolment and the key directory disagreeing is a finding, not a
      // detail to smooth over.
      try {
        await this.endpoint.confirmEndpoint(identity, { confirmed: true });
      } catch (error) {
        this.log('endpoint ' + row.userId + '/' + row.device + ' is enrolled as verified but its keys do not match the directory: '
          + (error.message || error));
        continue;
      }
      out.set(row.userId, identity);
    }
    return out;
  }

  // Tasks the relay has addressed to this host and this team.
  async pending() {
    const listed = await this.tasks.list(this.runtime.teamId);
    return (listed.tasks || []).filter((task) => task.runtimeId === this.runtime.id && !this.handled.has(task.id));
  }

  // One task, from opaque record to finished encrypted history.
  async run(wanted, { runTurn }) {
    const id = typeof wanted === 'string' ? wanted : wanted.id;
    if (this.running.has(id)) return this.running.get(id);
    const work = (async () => {
      // Always the relay's record, never the caller's object. The sealed creation request
      // and the routing tuple have to be the ones the relay actually stored, or the host is
      // verifying a task description somebody handed it against itself.
      const listed = await this.tasks.list(this.runtime.teamId);
      const task = (listed.tasks || []).find((t) => t.id === id);
      if (!task) return { skipped: 'unknown_task' };
      if (task.runtimeId !== this.runtime.id) return { skipped: 'foreign_runtime' };
      const project = this.projects.get(task.projectId);
      if (!project) {
        // Not an error: a task for a project this operator has not mapped is simply not
        // this host's to run, and saying so is better than picking a directory.
        this.log('encrypted task ' + task.id + ' has no local project mapping; leaving it alone');
        return { skipped: 'project_not_mapped' };
      }
      const creators = await this.verifiedEndpoints();
      const adapter = new EncryptedFixtureHost({
        runtime: this.runtime, endpoint: this.endpoint, transport: this.tasks, state: this.state,
        projects: new Map([[task.projectId, project]]),
        creators: new Map([...creators].map(([userId, identity]) => [userId, identity]))
      });
      const opened = await adapter.open(task);
      // Drain anything the hub is holding for this endpoint before writing: the creator's
      // session keys arrive the same way as everything else.
      await this.endpoint.open(await this.endpoint.transport.drain());
      const run = new EncryptedTaskRun({ opened, task, runTurn, log: this.log });
      const result = await run.start();
      this.handled.add(id);
      return { ...result, adapter, opened };
    })().finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }

  close() {
    try { this.endpoint?.close(); } catch {}
    try { this.state?.close(); } catch {}
  }
}

module.exports = { EncryptedHost };
