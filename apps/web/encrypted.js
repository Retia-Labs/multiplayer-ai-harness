// The browser's encrypted endpoint: enough of one to read a task, not to run one.
//
// #9's catch-up screen has been able to render a projection since it was built and has had
// nothing real to render, because the app had no way to decrypt anything. This is that way:
// an endpoint held in this browser's own store, published through #44's key exchange,
// announced to #8's enrolment, and used to replay a task #7's host actually ran.
//
// What it deliberately does not do is decide who to trust. It announces itself and waits to
// be confirmed by somebody who compared the fingerprint out of band, and it refuses to read
// a host's log until a person has confirmed that host the same way. An endpoint that could
// vouch for itself would make the whole ceremony decorative, and the relay - which serves
// every list this file reads - would become the thing deciding who may read what.
(function (global) {
  'use strict';

  const STORE_NAME = 'plexus-endpoint';
  const KEY_ITEM = 'plexus.endpoint.storeKey';
  const DEVICE_ITEM = 'plexus.endpoint.device';
  const HOST_ITEM = 'plexus.host.';       // + runtimeId -> the confirmed writer identity
  const CHECKPOINT_ITEM = 'plexus.task.'; // + taskId    -> {seq,hash}
  const ADMITTED_ITEM = 'plexus.admitted.';

  const held = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const hold = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const heldJSON = (key, fallback) => {
    try { const raw = held(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; }
  };

  let loaded = null;
  function modules() {
    if (!loaded) {
      loaded = Promise.all([
        import('/vendor/index.mjs'),
        import('/shared/e2ee/endpoint-core.mjs'),
        import('/shared/e2ee/hub-key-transport.mjs'),
        import('/shared/e2ee/task-log.mjs'),
        import('/shared/e2ee/enrollment.mjs'),
        import('/shared/e2ee/catchup.mjs'),
        import('/shared/e2ee/task-control.mjs'),
        import('/shared/protocol/encrypted-task.mjs')
      ]).then(([sdk, core, keys, log, enrol, view, control, protocol]) => {
        const api = core.createEndpointAPI(sdk);
        return {
          Endpoint: api.Endpoint, HubKeyTransport: keys.HubKeyTransport,
          matrixUser: protocol.matrixUser, ...log, ...enrol, ...view, ...control
        };
      });
    }
    return loaded;
  }

  // The store key lives in this browser and only this browser. That is weaker than a
  // desktop's OS-sealed key and it is the honest limit of a web page: clearing site data
  // destroys this identity, and #8 treats what comes back as a new device that has to be
  // confirmed again - the correct outcome rather than a bug to route around.
  function storeKey() {
    const saved = held(KEY_ITEM);
    if (saved) return Array.from(atob(saved), (c) => c.charCodeAt(0));
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hold(KEY_ITEM, btoa(String.fromCharCode.apply(null, bytes)));
    return Array.from(bytes);
  }

  function deviceName() {
    const saved = held(DEVICE_ITEM);
    if (saved) return saved;
    const name = 'WEB' + Array.from(crypto.getRandomValues(new Uint8Array(4)),
      (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    hold(DEVICE_ITEM, name);
    return name;
  }

  // A key in the form a person can actually compare out loud with somebody else.
  const fingerprint = (identity) => String((identity && identity.ed25519) || '').replace(/(.{4})/g, '$1 ').trim();

  class EncryptedClient {
    constructor({ token, userId, teamId }) {
      this.token = token;
      this.userId = userId;
      this.teamId = teamId;
      this.device = deviceName();
      this.endpoint = null;
    }

    async open() {
      const m = this.m = await modules();
      this.support = await m.Endpoint.storageSupport();
      this.endpoint = await m.Endpoint.create({
        user: m.matrixUser(this.userId),
        device: this.device,
        // Without a persistent store this identity dies with the tab, so that is reported
        // rather than silently producing a device to be re-confirmed on every reload.
        ...(this.support.persistent ? { storeName: STORE_NAME, storeKey: storeKey() } : {}),
        transport: new m.HubKeyTransport({ url: location.origin, token: this.token, device: this.device })
      });
      this.tasks = new m.EncryptedTaskTransport({ url: location.origin, token: this.token });
      this.enrolment = new m.EnrollmentTransport({ url: location.origin, token: this.token });
      const identity = this.endpoint.identity();
      return { ...identity, fingerprint: fingerprint(identity), durable: this.support.persistent };
    }

    // ---- being admitted ----

    // Announce, and be plain about what announcing is worth: nothing, until a teammate who
    // is already verified confirms this device's fingerprint.
    async announce() {
      const state = await this.enrolment.state(this.teamId);
      const listed = state.endpoints || [];
      const already = listed.find((e) => e.userId === this.userId && e.device === this.device);
      if (already) return { endpoint: already, known: true };
      const announcement = this.m.announcement(this.endpoint);
      // The first endpoint in a team has nobody to vouch for it, so the owner bootstraps.
      if (!listed.some((e) => e.state === 'verified') && state.me && state.me.role === 'owner') {
        const out = await this.enrolment.bootstrap(this.teamId, announcement);
        return { endpoint: out.endpoint, bootstrapped: true };
      }
      return this.enrolment.announce(this.teamId, announcement);
    }

    async enrolmentState() {
      const state = await this.enrolment.state(this.teamId);
      const all = state.endpoints || [];
      const mine = all.find((e) => e.userId === this.userId && e.device === this.device);
      return {
        device: this.device,
        state: mine ? mine.state : 'unannounced',
        confirmedBy: mine ? mine.confirmedBy : null,
        durable: !!(this.support && this.support.persistent),
        endpoints: all.map((e) => ({ ...e, fingerprint: fingerprint(e) }))
      };
    }

    // Confirm a teammate's endpoint. The caller is expected to have shown the fingerprint
    // and got a person to agree with it; this cannot check that and does not pretend to.
    async confirmTeammate(target) {
      // The enrolment speaks in account ids and the crypto store speaks in Matrix user ids.
      // Confirming needs both halves of that, and the keys are the part that actually
      // matters: a device whose keys do not match what was announced is refused here.
      await this.endpoint.confirmEndpoint({
        user: this.m.matrixUser(target.userId), device: target.device,
        curve25519: target.curve25519, ed25519: target.ed25519
      }, { confirmed: true });
      return this.enrolment.confirm(this.teamId, this.device, {
        userId: target.userId, device: target.device,
        curve25519: target.curve25519, ed25519: target.ed25519
      });
    }

    // ---- confirming a host ----

    // The endpoints an execution host has published. Listed by the relay and trusted by
    // nobody: the point of returning them is to put a fingerprint in front of a person.
    async hostEndpoints(runtimeId) {
      const listed = await this.endpoint.peerEndpoints(this.m.matrixUser(runtimeId));
      return listed.map((e) => ({ ...e, runtimeId, fingerprint: fingerprint(e) }));
    }

    // A host this browser will read from. Remembered, because a confirmation a person made
    // once should not be asked of them again on the next reload.
    async confirmHost(runtimeId, target) {
      await this.endpoint.confirmEndpoint(target, { confirmed: true });
      const writer = { user: target.user, device: target.device, curve25519: target.curve25519, ed25519: target.ed25519 };
      hold(HOST_ITEM + runtimeId, JSON.stringify(writer));
      return writer;
    }

    confirmedHost(runtimeId) { return heldJSON(HOST_ITEM + runtimeId, null); }

    // ---- reading ----

    // Tasks this account may fetch. Being able to fetch one is not being able to read it,
    // which is #8's whole point and why a replay can still refuse after this succeeds.
    async list() {
      const out = await this.tasks.list(this.teamId);
      return out.tasks || [];
    }

    // Start a task on a host this browser has confirmed. The creating request is sealed to
    // that host and to nobody else, which is why the confirmation has to come first: an
    // endpoint that would seal a task to whichever key a relay named would be handing its
    // objective to whoever answered.
    async createTask(runtimeId, projectId, payload) {
      const writer = this.confirmedHost(runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      const task = {
        version: 1, id: this.m.newId('et'), teamId: this.teamId,
        runtimeId, projectId, creatorUserId: this.userId
      };
      await this.m.createEncryptedTask(this.endpoint, this.tasks, { task, writer, payload });
      return task;
    }

    // Take delivery of whatever the hub is holding, so keys shared with this endpoint - a
    // task key, or a history handoff - take effect before a replay is attempted.
    async receiveKeys() {
      const envelopes = await this.endpoint.transport.drain();
      if (!envelopes.length) return { received: 0 };
      await this.endpoint.open(envelopes);
      return { received: envelopes.length };
    }

    // A history handoff from a teammate who granted this endpoint access to a project. The
    // admitted session ids are durable trust state: an endpoint that kept them only in
    // memory would hold the keys to its own history and refuse to read it after a reload.
    async acceptHandoff(taskId, handoff, writer) {
      const accepted = await this.m.acceptProjectAccess(this.endpoint, { history: handoff }, { writer });
      const admitted = new Set(heldJSON(ADMITTED_ITEM + taskId, []).concat(accepted.sessions));
      hold(ADMITTED_ITEM + taskId, JSON.stringify([...admitted]));
      return { imported: accepted.imported, sessions: accepted.sessions };
    }

    /**
     * Replay one task and hand the catch-up screen a projection.
     *
     * Returns `{projection, snapshot}`, or `{error}` with a code the screen can render as a
     * state. The two failures worth telling apart are already distinct: `host_unconfirmed`
     * means nobody has vouched for the writer yet, and `task_integrity_failed` means
     * somebody has and the log still did not verify.
     */
    async catchUp(task, context) {
      const ctx = context || {};
      const writer = ctx.writer || this.confirmedHost(task.runtimeId);
      if (!writer) return { error: 'host_unconfirmed', runtimeId: task.runtimeId };
      await this.receiveKeys();
      const reader = new this.m.EncryptedTaskReader({
        endpoint: this.endpoint, task, writer,
        checkpoint: heldJSON(CHECKPOINT_ITEM + task.id, undefined),
        admittedSessions: heldJSON(ADMITTED_ITEM + task.id, []),
        onStatus: ctx.onStatus || (() => {})
      });
      let snapshot;
      try {
        snapshot = await reader.reconnect(this.tasks);
      } catch (error) {
        return { error: error.code || 'task_integrity_failed', seq: reader.seq };
      }
      // Only a replay that verified may move the floor a later one is checked against.
      hold(CHECKPOINT_ITEM + task.id, JSON.stringify(reader.checkpoint()));
      return {
        snapshot,
        projection: this.m.catchUp(snapshot, {
          taskId: task.id,
          projectId: task.projectId,
          now: ctx.now || Date.now(),
          lastEventAt: ctx.lastEventAt === undefined ? null : ctx.lastEventAt,
          hostConnected: ctx.hostConnected === undefined ? null : ctx.hostConnected,
          responsible: ctx.responsible || null,
          host: ctx.host || task.runtimeId,
          provider: ctx.provider || null
        })
      };
    }

    // ---- asking a named teammate ----

    // Ask somebody about this task. The question never reaches a provider: it is sealed to
    // the host, which records it as a question for a person. Nothing on this path can turn
    // into agent input, which is the point of it being a separate call from starting a turn.
    async askForHelp(task, { question, recipient }) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      const text = typeof question === 'string' ? question.trim() : '';
      if (!text) throw Object.assign(new Error('help_needs_a_question'), { code: 'help_needs_a_question' });
      const id = 'help_' + Array.from(crypto.getRandomValues(new Uint8Array(8)),
        (v) => v.toString(16).padStart(2, '0')).join('');
      await this.m.sendTaskControl(this.endpoint, writer, {
        task, action: 'help.request', payload: { id, question: text, recipient }
      });
      return { id };
    }

    // The recipient dealt with it, or the asker withdrew it. The host decides which of those
    // this caller is allowed to say; sending the other is refused there, not here.
    async settleHelp(task, id, outcome) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      await this.m.sendTaskControl(this.endpoint, writer, {
        task, action: 'help.settle', payload: { id, outcome: outcome === 'cancelled' ? 'cancelled' : 'resolved' }
      });
      return { id, outcome };
    }

    // Every open question addressed to this account, across the tasks this endpoint can
    // read. Built from the same projections the task views render, so the inbox and the task
    // cannot disagree about whether something is still open.
    async inbox(context) {
      const tasks = await this.list();
      const projections = [];
      for (const task of tasks) {
        const out = await this.catchUp(task, context);
        if (out.projection) projections.push({ task, projection: out.projection });
      }
      return this.m.inbox(projections, this.userId).map((entry) => ({
        ...entry,
        task: (projections.find((p) => p.projection.scope.taskId === entry.taskId) || {}).task || null
      }));
    }

    close() { try { if (this.endpoint) this.endpoint.close(); } catch {} }
  }

  global.PlexusEncrypted = { EncryptedClient, deviceName, fingerprint };
})(typeof window !== 'undefined' ? window : globalThis);
