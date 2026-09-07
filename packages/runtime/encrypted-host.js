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
const crypto = require('node:crypto');
const { Endpoint } = require('../e2ee/endpoint');
const { HubKeyTransport } = require('../e2ee/hub-key-transport.mjs');
const { EncryptedTaskTransport } = require('../e2ee/task-log.mjs');
const { matrixUser } = require('../protocol/encrypted-task.mjs');
const { readTaskControl, ENVELOPE_TYPE, HISTORY_TYPE } = require('../e2ee/task-control.mjs');
const { normalizeLink, normalizeLinkTitle } = require('../protocol/related-work.mjs');
const { routing } = require('../e2ee/task-log.mjs');
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
    this.handedOff = new Set();
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

  // Who holds a live grant on a project, as the relay records it. This is the relay's own
  // gate - membership of a project, not decryption authority - and it is the right one to
  // ask here: "may this person be sent a question about this work" is exactly a grant.
  async participants(projectId) {
    const response = await fetch(this.url + '/api/enrollment?team=' + encodeURIComponent(this.runtime.teamId) +
      '&project=' + encodeURIComponent(projectId), {
      headers: { Authorization: 'Bearer ' + this.runtime.runtimeToken, 'X-Plexus-Runtime': this.runtime.id },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('enrollment_unavailable');
    const state = await response.json();
    return new Map((state.participants || []).map((p) => [p.userId, p]));
  }

  // Everyone a live project grant covers, handed the key to a task they may now read.
  //
  // A grant is the relay's gate and hands nobody a key: the host owns the group session, so
  // it is the only party that can share one. Re-sharing to the current member set is also
  // what makes removal mean something, because the next share leaves out whoever was
  // revoked. Poll-based like everything else here - a grant takes effect when the host next
  // looks, and there is no push.
  async admitParticipants(task) {
    const project = this.projects.get(task.projectId);
    if (!project) return { admitted: [], skipped: 'project_not_mapped' };
    const holders = await this.participants(task.projectId);
    const verified = await this.verifiedEndpoints();
    const members = [];
    for (const userId of holders.keys()) {
      const identity = verified.get(userId);
      // A grant without a verified endpoint is a person who may join and has not yet proved
      // which device they are. Nothing is shared with a device nobody has confirmed.
      if (identity) members.push({ userId, identity });
    }
    if (!members.length) return { admitted: [] };

    const creators = await this.verifiedEndpoints();
    const adapter = new EncryptedFixtureHost({
      runtime: this.runtime, endpoint: this.endpoint, transport: this.tasks, state: this.state,
      projects: new Map([[task.projectId, project]]),
      creators: new Map([...creators].map(([userId, identity]) => [userId, identity]))
    });
    await adapter.open(task);

    // History first. A teammate admitted to the session but not handed what came before
    // would replay from event one and fail on the first event they cannot decrypt.
    const handed = [];
    for (const member of members) {
      const key = task.id + '/' + member.identity.user + '/' + member.identity.device;
      if (this.handedOff.has(key)) continue;
      const history = await adapter.handOff(task, { userId: member.userId, device: member.identity.device });
      const envelope = await this.endpoint.sealControl(member.identity.user, member.identity.device, {
        type: HISTORY_TYPE, task: routing(task), history
      });
      await this.endpoint.transport.deliverToDevice(member.identity.user, member.identity.device, envelope);
      this.handedOff.add(key);
      handed.push(member.userId);
    }
    // Then the session itself, so everything written afterwards needs no further handoff.
    await adapter.admit(task, members.map((m) => m.identity));
    return { admitted: members.map((m) => m.userId), handed };
  }

  // Applying a revocation, which is the only part of it that actually removes anybody.
  //
  // The relay can stop serving a revoked device the moment somebody clicks. It cannot take
  // back a key that device already holds - so the removal that matters happens here: the group
  // session is thrown away and re-shared to the members who are left, and everything written
  // afterwards is unreadable to the device that was removed.
  //
  // What this cannot do is unsay what was already said. Events the removed endpoint had
  // already decrypted stay decrypted, on their machine, forever. See REVOCATION_LIMITS.
  async applyRevocations(tasks) {
    const response = await fetch(this.url + '/api/enrollment?team=' + encodeURIComponent(this.runtime.teamId), {
      headers: { Authorization: 'Bearer ' + this.runtime.runtimeToken, 'X-Plexus-Runtime': this.runtime.id },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('enrollment_unavailable');
    const state = await response.json();
    const mine = (state.revocations || []).filter((r) => !r.appliedBy.includes(this.runtime.id));
    if (!mine.length) return { applied: [], rotated: [] };

    // Rotate every task this host owns. A revoked endpoint may have held the key to any of
    // them, and working out which is a guess this host has no reason to make.
    const listed = tasks || (await this.tasks.list(this.runtime.teamId)).tasks || [];
    const owned = listed.filter((task) => task.runtimeId === this.runtime.id && this.projects.get(task.projectId));
    const rotated = [];
    for (const task of owned) {
      const holders = await this.participants(task.projectId);
      const verified = await this.verifiedEndpoints();
      const members = [...holders.keys()].map((userId) => verified.get(userId)).filter(Boolean);
      const adapter = new EncryptedFixtureHost({
        runtime: this.runtime, endpoint: this.endpoint, transport: this.tasks, state: this.state,
        projects: new Map([[task.projectId, this.projects.get(task.projectId)]]),
        creators: new Map([...verified].map(([userId, identity]) => [userId, identity]))
      });
      await adapter.open(task);
      // rotate: the difference between adding somebody and removing somebody.
      await adapter.admit(task, members, { rotate: true });
      rotated.push(task.id);
    }

    const applied = [];
    for (const revocation of mine) {
      const ack = await fetch(this.url + '/api/enrollment/ack-revocation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.runtime.runtimeToken,
          'X-Plexus-Runtime': this.runtime.id
        },
        body: JSON.stringify({ teamId: this.runtime.teamId, target: { userId: revocation.userId, device: revocation.device } }),
        signal: AbortSignal.timeout(10000)
      });
      if (ack.ok) applied.push({ userId: revocation.userId, device: revocation.device });
    }
    this.log('applied ' + applied.length + ' revocation(s), rotated ' + rotated.length + ' task key(s)');
    return { applied, rotated };
  }

  // Control messages teammates have sealed to this host, applied to the tasks they name.
  //
  // The mailbox is drained once and dispatched, because draining is destructive: collecting
  // "for one task" would throw away every message addressed to the others. Poll-based like
  // pending() - a request is picked up when the host next looks, and there is no push.
  async collect() {
    const envelopes = await this.endpoint.transport.drain();
    if (!envelopes.length) return { applied: [], refused: [] };
    // The same call takes delivery of room keys, which share this mailbox.
    const events = await this.endpoint.open(envelopes);
    const control = events.filter((event) => event && event.type === ENVELOPE_TYPE);
    if (!control.length) return { applied: [], refused: [] };

    const listed = await this.tasks.list(this.runtime.teamId);
    const mine = (listed.tasks || []).filter((task) => task.runtimeId === this.runtime.id);
    const applied = [];
    const refused = [];
    for (const event of control) {
      let match = null;
      for (const task of mine) {
        let read = null;
        try { read = readTaskControl(event, task); }
        catch (error) { refused.push({ code: error.code || 'invalid_task_control' }); match = 'refused'; break; }
        if (read) { match = { task, read }; break; }
      }
      if (match === 'refused') continue;
      // A message naming a task this host does not hold is dropped rather than guessed at.
      if (!match) { refused.push({ code: 'unknown_task_control_target' }); continue; }
      try {
        applied.push(await this.apply(match.task, match.read));
      } catch (error) {
        this.log('task control refused: ' + (error.code || error.message));
        refused.push({ taskId: match.task.id, code: error.code || 'task_control_refused' });
      }
    }
    return { applied, refused };
  }

  // The enrolment's current verdict on one device, fetched rather than remembered.
  //
  // Local trust is sticky on purpose - this host confirmed that device once and has no reason
  // to forget - so "can it still seal to me" keeps saying yes long after the team removed it.
  // Whether it may still *act* is a live question, and the only honest answer comes from
  // asking now.
  async endpointStanding(userId, device) {
    const response = await fetch(this.url + '/api/enrollment?team=' + encodeURIComponent(this.runtime.teamId), {
      headers: { Authorization: 'Bearer ' + this.runtime.runtimeToken, 'X-Plexus-Runtime': this.runtime.id },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('enrollment_unavailable');
    const state = await response.json();
    const row = (state.endpoints || []).find((e) => e.userId === userId && e.device === device);
    return row ? row.state : 'unknown';
  }

  // One authorized control message, turned into one log event.
  async apply(task, { sender, senderDevice, action, payload }) {
    const project = this.projects.get(task.projectId);
    if (!project) throw Object.assign(new Error('project_not_mapped'), { code: 'project_not_mapped' });
    const holders = await this.participants(task.projectId);
    // Being able to seal to this host is being a verified endpoint. It is not being on the
    // project, and the two gates are deliberately different: cryptography says who you are,
    // the grant says what you are part of.
    if (!holders.has(sender)) throw Object.assign(new Error('sender_not_in_project'), { code: 'sender_not_in_project' });

    // A revoked device keeps its account's project grant - the grant is about the person, the
    // revocation is about the machine - so the grant alone would let a removed laptop go on
    // authorising work. Rotation stops it reading; this is what stops it acting.
    const standing = await this.endpointStanding(sender, senderDevice);
    if (standing !== 'verified') {
      throw Object.assign(new Error('endpoint_' + standing), { code: standing === 'revoked' ? 'endpoint_revoked' : 'endpoint_not_verified' });
    }

    const creators = await this.verifiedEndpoints();
    const adapter = new EncryptedFixtureHost({
      runtime: this.runtime, endpoint: this.endpoint, transport: this.tasks, state: this.state,
      projects: new Map([[task.projectId, project]]),
      creators: new Map([...creators].map(([userId, identity]) => [userId, identity]))
    });
    const opened = await adapter.open(task);
    // Help requests carry their own id; an outcome or a handover is identified by what it
    // is and who sent it, which is enough to make a redelivered envelope idempotent without
    // letting a caller choose the identity of an event it does not own.
    const id = ['help.request', 'help.settle', 'link.add', 'link.remove'].includes(action)
      ? String(payload.id || '')
      : action + ':' + sender;
    if (!/^[A-Za-z0-9_:.-]{1,96}$/.test(id)) throw Object.assign(new Error('invalid_task_control'), { code: 'invalid_task_control' });

    let event;
    if (action === 'help.request') {
      const recipient = String(payload.recipient || '');
      const question = typeof payload.question === 'string' ? payload.question.trim() : '';
      if (!question) throw Object.assign(new Error('help_needs_a_question'), { code: 'help_needs_a_question' });
      // The criterion this exists for: a question addressed outside the project is refused
      // rather than recorded and left unanswerable.
      if (!holders.has(recipient)) throw Object.assign(new Error('recipient_not_in_project'), { code: 'recipient_not_in_project' });
      event = { type: 'help.requested', payload: { id, question, from: sender, recipient } };
    } else if (action === 'help.settle') {
      const held = opened.reader.state.help.find((entry) => entry.id === id);
      if (!held) throw Object.assign(new Error('unknown_help_request'), { code: 'unknown_help_request' });
      const outcome = payload.outcome === 'cancelled' ? 'cancelled' : 'resolved';
      // The recipient deals with a question; the person who asked withdraws it. Nobody else
      // closes somebody's question on their behalf.
      const may = outcome === 'resolved' ? held.recipient : held.from;
      if (sender !== may) throw Object.assign(new Error('not_the_help_owner'), { code: 'not_the_help_owner' });
      event = { type: 'help.settled', payload: { id, by: sender, outcome } };
    } else if (action === 'task.outcome') {
      // Closing the work is a decision about the work, so it belongs to whoever is on the
      // project. The turn's own result is recorded separately and by the machine; this is
      // the only event that says the task itself is done, and it names who said so.
      const outcome = payload.outcome === 'cancelled' ? 'cancelled' : 'completed';
      if (opened.reader.state.outcome) throw Object.assign(new Error('task_already_settled'), { code: 'task_already_settled' });
      event = { type: 'task.completed', payload: { outcome, by: sender } };
    } else if (action === 'responsibility.handover') {
      const to = String(payload.to || '');
      // The recipient must already be on the project. Handing responsibility to somebody
      // without access would be a grant made sideways, and the whole point of the two gates
      // is that access is granted deliberately rather than inherited from being handed work.
      if (!holders.has(to)) throw Object.assign(new Error('recipient_not_in_project'), { code: 'recipient_not_in_project' });
      const note = typeof payload.note === 'string' ? payload.note.trim() : '';
      const from = opened.reader.state.responsible || task.creatorUserId || null;
      event = { type: 'responsibility.changed', payload: {
        to, by: sender, ...(from ? { from } : {}), ...(note ? { note } : {})
      } };
    } else if (action === 'link.add') {
      // Validated here because this is the copy everybody else renders. A client checks too,
      // so it can say no without a round trip, but a client that skipped the check gets the
      // same answer - which is the only arrangement worth having.
      let url;
      let title;
      try {
        url = normalizeLink(payload.url);
        title = normalizeLinkTitle(payload.title);
      } catch (error) {
        throw Object.assign(new Error(error.code || 'invalid_link_url'), { code: error.code || 'invalid_link_url' });
      }
      if (opened.reader.state.links.some((link) => link.id === id && !link.removedBy)) {
        throw Object.assign(new Error('task_link_exists'), { code: 'task_link_exists' });
      }
      event = { type: 'link.added', payload: { id, url, by: sender, ...(title ? { title } : {}) } };
    } else if (action === 'link.remove') {
      const held = opened.reader.state.links.find((link) => link.id === id);
      if (!held || held.removedBy) throw Object.assign(new Error('unknown_task_link'), { code: 'unknown_task_link' });
      event = { type: 'link.removed', payload: { id, by: sender } };
    } else {
      throw Object.assign(new Error('unsupported_task_control'), { code: 'unsupported_task_control' });
    }

    // Deterministic, so a redelivered envelope is recognised as the same event rather than
    // appended twice - #6's writer refuses a reused id whose content differs.
    const eventId = 'ev_' + crypto.createHash('sha256').update(task.id + ':' + event.type + ':' + id).digest('hex').slice(0, 32);
    await opened.writer.append(event, eventId);
    return { taskId: task.id, type: event.type, id };
  }

  // One task, from opaque record to finished encrypted history.
  async run(wanted, { runTurn, provider = null }) {
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
      const run = new EncryptedTaskRun({ opened, task, runTurn, provider, log: this.log });
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
