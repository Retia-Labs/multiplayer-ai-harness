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
  const HOST_ROSTER_ITEM = 'plexus.known-hosts.';
  const CHECKPOINT_ITEM = 'plexus.task.'; // + taskId    -> {seq,hash}
  const ADMITTED_ITEM = 'plexus.admitted.';
  const MAILBOX_ITEM = 'plexus.mailbox.';
  const RECOVERY_TRUST_ITEM = 'plexus.recovered-history.';

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
        import('/shared/protocol/encrypted-task.mjs'),
        import('/shared/protocol/related-work.mjs'),
        import('/shared/e2ee/recovery.mjs')
      ]).then(([sdk, core, keys, log, enrol, view, control, protocol, links, recovery]) => {
        const api = core.createEndpointAPI(sdk);
        return {
          Endpoint: api.Endpoint, HubKeyTransport: keys.HubKeyTransport,
          matrixUser: protocol.matrixUser, roomFor: protocol.roomFor,
          ...log, ...enrol, ...view, ...control, ...links, ...recovery
        };
      });
    }
    return loaded;
  }

  // The store key lives in this browser and only this browser. That is weaker than a
  // desktop's OS-sealed key and it is the honest limit of a web page: clearing site data
  // destroys this identity, and #8 treats what comes back as a new device that has to be
  // confirmed again - the correct outcome rather than a bug to route around.
  function storeKey(account) {
    const saved = held(KEY_ITEM + '.' + account);
    if (saved) return Array.from(atob(saved), (c) => c.charCodeAt(0));
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hold(KEY_ITEM + '.' + account, btoa(String.fromCharCode.apply(null, bytes)));
    return Array.from(bytes);
  }

  function deviceName(account = '') {
    const item = DEVICE_ITEM + '.' + account;
    const saved = held(item);
    if (saved) return saved;
    const name = 'WEB' + Array.from(crypto.getRandomValues(new Uint8Array(4)),
      (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    hold(item, name);
    return name;
  }

  // A key in the form a person can actually compare out loud with somebody else.
  const fingerprint = (identity) => String((identity && identity.ed25519) || '').replace(/(.{4})/g, '$1 ').trim();

  class EncryptedClient {
    constructor({ token, userId, teamId }) {
      this.token = token;
      this.userId = userId;
      this.teamId = teamId;
      this.device = deviceName(userId);
      this.endpoint = null;
      this.receipts = new Map();
      this.pendingCommands = new Map();
      this.mailboxWork = Promise.resolve();
      this.prefix = userId + '.' + teamId + '.';
      this.url = location.origin;
    }

    storageKey(kind, id = '') { return kind + this.prefix + id; }

    async open() {
      const m = this.m = await modules();
      this.support = await m.Endpoint.storageSupport();
      // A temporarily unavailable store must never replace the saved device's keys with
      // a fresh memory identity. This applies to browser and desktop product clients.
      if (!this.support.persistent) throw Object.assign(new Error('Encrypted storage is unavailable. Restore storage access and try again.'), { code: 'endpoint_storage_unavailable' });
      const desktopKey = global.harnessDesktop?.endpointStoreKey
        ? await global.harnessDesktop.endpointStoreKey() : null;
      this.endpoint = await m.Endpoint.create({
        user: m.matrixUser(this.userId),
        device: this.device,
        recoveredHistory: heldJSON(this.storageKey(RECOVERY_TRUST_ITEM), []),
        storeName: STORE_NAME + '-' + this.userId,
        storeKey: desktopKey ? (Array.isArray(desktopKey) ? desktopKey : desktopKey.key) : storeKey(this.userId),
        transport: new m.HubKeyTransport({ url: this.url, token: this.token, device: this.device })
      });
      this.tasks = new m.EncryptedTaskTransport({ url: this.url, token: this.token });
      this.recovery = new m.RecoveryTransport({ url: this.url, token: this.token });
      this.enrolment = new m.EnrollmentTransport({ url: this.url, token: this.token, endpoint: this.endpoint,
        loadCheckpoint: team => heldJSON(this.storageKey('plexus.membership.', team), null),
        saveCheckpoint: (team, head) => hold(this.storageKey('plexus.membership.', team), JSON.stringify(head)) });
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

    async enrolmentState({ hosts = [] } = {}) {
      const state = await this.enrolment.state(this.teamId);
      const all = state.endpoints || [];
      const mine = all.find((e) => e.userId === this.userId && e.device === this.device);
      let membershipIdentity = null;
      try {
        const head = await this.enrolment.signedHead(this.teamId, state);
        const identity = this.endpoint.identity();
        const admitted = head.endpoints?.find(endpoint => ['user', 'device', 'curve25519', 'ed25519'].every(key => endpoint[key] === identity[key]));
        membershipIdentity = { owner: head.owner || null, state: admitted?.state || 'pending',
          checkpoint: { seq: head.seq, hash: head.hash } };
      } catch (error) {
        // A clean device still needs the original authority comparison. Relay endpoint
        // labels cannot make that device eligible for host-local authority recovery.
        if (error.code !== 'membership_authority_required') throw error;
      }
      // Remember hosts already seen by this device. A relay omitting an offline host
      // later cannot turn its missing revocation proof into a reassuring "applied".
      const knownHosts = new Set(heldJSON(this.storageKey(HOST_ROSTER_ITEM), []));
      for (const host of hosts) if (host.runtimeId || host.id) knownHosts.add(host.runtimeId || host.id);
      for (const revocation of state.revocations || []) {
        for (const runtimeId of [...(revocation.pendingHosts || []), ...(revocation.appliedBy || [])]) knownHosts.add(runtimeId);
      }
      hold(this.storageKey(HOST_ROSTER_ITEM), JSON.stringify([...knownHosts]));
      const revocations = await this.m.verifyRevocationReceipts(state.revocations || [], {
        hosts: [...knownHosts].map(runtimeId => ({ runtimeId, identity: this.confirmedHost(runtimeId) })),
        authorityLog: state.authorityLog || []
      });
      return {
        device: this.device,
        state: mine ? mine.state : 'unannounced',
        confirmedBy: mine ? mine.confirmedBy : null,
        durable: !!(this.support && this.support.persistent),
        membershipIdentity,
        endpoints: all.map((e) => ({ ...e, fingerprint: fingerprint(e) })),
        revocations,
        pendingHosts: [...new Set(revocations.flatMap(entry => entry.pendingHosts))]
      };
    }

    async projectAccess(projectId) { return this.enrolment.state(this.teamId, projectId); }
    async authorityEndpoints() {
      const state = await this.enrolment.state(this.teamId);
      const identity = state.authorityLog?.[0]?.signer;
      return identity ? [{ ...identity, fingerprint: fingerprint(identity) }] : [];
    }
    async confirmAuthority(identity) {
      await this.endpoint.confirmEndpoint(identity, { confirmed: true });
      return this.enrolment.pinAuthority(this.teamId, identity);
    }
    async grantProject(projectId, { userId, role = 'participant' }) {
      return this.enrolment.grant(this.teamId, projectId, userId, role);
    }
    async revokeDevice(target) { return this.enrolment.revokeEndpoint(this.teamId, target); }
    async answerChallenges() {
      if (!this.enrolment.answerChallenges) return { answered: 0 };
      try { return await this.enrolment.answerChallenges(this.teamId); }
      catch (error) {
        if (error.code === 'membership_authority_required') return { answered: 0, pending: 'authority_confirmation_required' };
        throw error;
      }
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
      hold(this.storageKey(HOST_ITEM, runtimeId), JSON.stringify(writer));
      const known = new Set(heldJSON(this.storageKey(HOST_ROSTER_ITEM), [])); known.add(runtimeId);
      hold(this.storageKey(HOST_ROSTER_ITEM), JSON.stringify([...known]));
      return writer;
    }

    confirmedHost(runtimeId) { return heldJSON(this.storageKey(HOST_ITEM, runtimeId), null); }

    async controlHost(runtimeId) {
      const writer = this.confirmedHost(runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      // A customer-authenticated backup can restore this exact recipient pin while
      // leaving the clean SDK store without device trust. Match the live published
      // keys before restoring that trust; never adopt a replacement from the relay.
      // Trusting the recipient grants this client no membership or approval rights.
      await this.endpoint.confirmEndpoint(writer, { confirmed: true });
      return writer;
    }

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
      const writer = await this.controlHost(runtimeId);
      const task = {
        version: 1, id: this.m.newId('et'), teamId: this.teamId,
        runtimeId, projectId, creatorUserId: this.userId
      };
      if (this.enrolment.ownProject) await this.enrolment.ownProject(this.teamId, projectId);
      await this.m.createEncryptedTask(this.endpoint, this.tasks, { task, writer, payload });
      return task;
    }

    // Take delivery of whatever the hub is holding, so keys shared with this endpoint - a
    // task key, or a history handoff - take effect before a replay is attempted.
    receiveKeys() {
      const work = this.mailboxWork.then(() => this.dispatchMailbox());
      this.mailboxWork = work.catch(() => {});
      return work;
    }

    async dispatchMailbox() {
      const mailboxKey = this.storageKey(MAILBOX_ITEM, this.device);
      // Keep encrypted envelopes durably before decoding. Confirming a host later must not
      // lose a history handoff that happened to arrive before its fingerprint was checked.
      const saved = heldJSON(mailboxKey, []);
      const fresh = await this.endpoint.transport.drain();
      const envelopes = saved.concat(fresh);
      if (!envelopes.length) return { received: 0 };
      hold(mailboxKey, JSON.stringify(envelopes));
      const tasks = await this.list();
      const remaining = [];
      for (const envelope of envelopes) {
        let events;
        try { events = await this.endpoint.open([envelope]); }
        catch { remaining.push(envelope); continue; }
        let retain = false;
        for (const event of events) {
          if (event.type !== this.m.ENVELOPE_TYPE) continue;
          const task = tasks.find(candidate => candidate.id === event.content?.task?.id);
          if (!task) { retain = true; continue; }
          const writer = this.confirmedHost(task.runtimeId);
          if (!writer) { retain = true; continue; }
          try {
            if (event.content?.type === this.m.HISTORY_TYPE) {
              const transfer = this.m.readTaskHistory(event, task);
              if (transfer) await this.acceptHandoff(task.id, transfer.history, writer);
            } else if (event.content?.type === this.m.RECEIPT_TYPE) {
              const receipt = this.m.readTaskReceipt(event, task, writer);
              if (receipt) this.receipts.set(receipt.commandId, receipt);
            }
          } catch (error) {
            // Failed authentication remains a refusal. Keep the sealed material so a
            // transient key-directory outage is retryable rather than destructive.
            retain = true;
            this.mailboxError = error.code || error.message;
          }
        }
        if (retain) remaining.push(envelope);
      }
      hold(mailboxKey, JSON.stringify(remaining));
      return { received: fresh.length, pending: remaining.length };
    }

    // A history handoff from a teammate who granted this endpoint access to a project. The
    // admitted session ids are durable trust state: an endpoint that kept them only in
    // memory would hold the keys to its own history and refuse to read it after a reload.
    async acceptHandoff(taskId, handoff, writer) {
      const accepted = await this.m.acceptProjectAccess(this.endpoint, { history: handoff }, { writer });
      if (accepted.teamId !== this.teamId || !accepted.rooms.includes(this.m.roomFor(taskId))) throw new Error('project_history_scope_mismatch');
      const admittedKey = this.storageKey(ADMITTED_ITEM, taskId);
      const admitted = new Set(heldJSON(admittedKey, []).concat(accepted.sessions));
      hold(admittedKey, JSON.stringify([...admitted]));
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
        checkpoint: heldJSON(this.storageKey(CHECKPOINT_ITEM, task.id), undefined),
        admittedSessions: heldJSON(this.storageKey(ADMITTED_ITEM, task.id), []),
        onStatus: ctx.onStatus || (() => {})
      });
      let snapshot;
      try {
        snapshot = await reader.reconnect(this.tasks);
      } catch (error) {
        return { error: error.code || 'task_integrity_failed', seq: reader.seq };
      }
      // Only a replay that verified may move the floor a later one is checked against.
      hold(this.storageKey(CHECKPOINT_ITEM, task.id), JSON.stringify(reader.checkpoint()));
      for (const receipt of snapshot.receipts || []) {
        this.receipts.set(receipt.commandId, { ...this.receipts.get(receipt.commandId), ...receipt });
      }
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

    async sendControl(task, action, payload, { commandId } = {}) {
      const writer = await this.controlHost(task.runtimeId);
      const enrollment = await this.enrolmentState();
      if (enrollment.state !== 'verified') throw Object.assign(new Error('endpoint_' + enrollment.state), { code: 'endpoint_' + enrollment.state });
      const sent = await this.m.sendTaskControl(this.endpoint, writer, { task, action, payload,
        ...(commandId ? { commandId } : {}) });
      this.pendingCommands.set(sent.commandId, { task, action, payload });
      if (!this.receipts.has(sent.commandId)) this.receipts.set(sent.commandId, sent);
      return this.receipts.get(sent.commandId);
    }

    receipt(commandId) { return this.receipts.get(commandId) || null; }
    async retry(commandId) {
      const held = this.pendingCommands.get(commandId);
      if (!held) throw new Error('unknown_command');
      return this.sendControl(held.task, held.action, held.payload, { commandId });
    }
    startTurn(task, payload, options) { return this.sendControl(task, 'turn.start', payload, options); }
    steer(task, payload, options) {
      if (!payload.expectedTurnId) throw new Error('turn_binding_required');
      return this.sendControl(task, 'turn.steer', payload, options);
    }
    interrupt(task, payload, options) {
      if (!payload.turnId) throw new Error('turn_binding_required');
      return this.sendControl(task, 'turn.interrupt', payload, options);
    }
    resolveApproval(task, payload, options) {
      if (!payload.requestId || !payload.turnId || !payload.fingerprint) throw new Error('approval_binding_required');
      return this.sendControl(task, 'approval.resolve', payload, options);
    }
    grantApproval(task, payload, options) { return this.sendControl(task, 'approval.grant', payload, options); }
    revokeApproval(task, payload, options) { return this.sendControl(task, 'approval.revoke', payload, options); }
    requestDiff(task, options) { return this.sendControl(task, 'task.diff', {}, options); }

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
      const sent = await this.sendControl(task, 'help.request', { id, question: text, recipient });
      return { id, ...sent };
    }

    // The recipient dealt with it, or the asker withdrew it. The host decides which of those
    // this caller is allowed to say; sending the other is refused there, not here.
    async settleHelp(task, id, outcome) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      const sent = await this.sendControl(task, 'help.settle', { id, outcome: outcome === 'cancelled' ? 'cancelled' : 'resolved' });
      return { id, outcome, ...sent };
    }

    // ---- recovery ----
    //
    // The key is generated here and shown once. It is never sent anywhere and never stored by
    // this app: what reaches the relay is history encrypted to it, and the relay cannot open
    // that. Which is why the drill exists - a key displayed once and not written down is not
    // recovery, and the only moment anybody will check is before it is needed.

    async recoveryState() {
      try {
        const listed = await this.recovery.list();
        return { backups: listed.backups || [], limits: this.m.RECOVERY_LIMITS };
      } catch (error) {
        return { backups: [], limits: this.m.RECOVERY_LIMITS, error: error.code || 'recovery_unavailable' };
      }
    }

    // Step one: issue a key. Nothing is backed up yet, because nothing should be relied on
    // until somebody has proved they can reproduce it.
    async beginRecoverySetup() {
      const issued = await this.endpoint.enableRecovery();
      return { recoveryKey: issued.recoveryKey };
    }

    // Step two: they type it back, and only then is anything stored.
    async completeRecoverySetup(issuedKey, typed, { scope, taskIds }) {
      this.m.confirmRecoveryDrill(issuedKey, typed);
      const tasks = await this.list();
      for (const task of tasks.filter(task => taskIds.includes(task.id))) {
        const read = await this.catchUp(task);
        if (read.error) throw new Error(read.error);
      }
      return this.m.backupHistory(this.endpoint, this.recovery, {
        scope, taskIds, recoveryKey: issuedKey, roomFor: this.m.roomFor
      });
    }

    async replaceRecoveryKey({ scope, taskIds }) {
      return this.m.rotateRecovery(this.endpoint, this.recovery, { scope, taskIds, roomFor: this.m.roomFor });
    }

    // On a clean device: the customer's key, and nothing from the operator.
    async restoreFromRecovery({ scope, taskIds, recoveryKey }) {
      const restored = await this.m.restoreHistory(this.endpoint, this.recovery, {
        scope, taskIds, recoveryKey, roomFor: this.m.roomFor
      });
      const tasks = await this.list();
      const recoveredTrust = heldJSON(this.storageKey(RECOVERY_TRUST_ITEM), []);
      for (const [taskId, history] of Object.entries(restored.restored.history)) {
        const task = tasks.find(task => task.id === taskId);
        if (!task || history.writer.user !== this.m.matrixUser(task.runtimeId)) continue;
        // The customer-authenticated manifest restores the old host pin, not any authority
        // for this new endpoint to act on that host. Enrollment stays pending.
        hold(this.storageKey(HOST_ITEM, task.runtimeId), JSON.stringify(history.writer));
        hold(this.storageKey(ADMITTED_ITEM, taskId), JSON.stringify(history.sessions));
        for (const sessionId of history.sessions) recoveredTrust.push({ roomId: this.m.roomFor(taskId), sessionId, writer: history.writer });
      }
      hold(this.storageKey(RECOVERY_TRUST_ITEM), JSON.stringify([...new Map(recoveredTrust.map(entry => [entry.roomId + '/' + entry.sessionId, entry])).values()]));
      this.recovered = true;
      return restored;
    }

    canReadHistory(taskId) {
      return heldJSON(this.storageKey(RECOVERY_TRUST_ITEM), []).some(entry => entry.roomId === this.m.roomFor(taskId));
    }

    // ---- related work ----

    // Store the issue or PR this task belongs to. Checked here so the person typing it gets
    // an answer immediately, and checked again by the host, which is the copy that counts.
    // Adding one talks to nobody: no request is made to the tracker, then or ever.
    async addLink(task, { url, title }) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      const href = this.m.normalizeLink(url);
      const id = 'lnk_' + Array.from(crypto.getRandomValues(new Uint8Array(8)),
        (v) => v.toString(16).padStart(2, '0')).join('');
      const sent = await this.sendControl(task, 'link.add', { id, url: href, ...(title ? { title: String(title) } : {}) });
      return { id, url: href, ...sent };
    }

    async removeLink(task, id) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      return { id, ...await this.sendControl(task, 'link.remove', { id }) };
    }

    // The link somebody copies to point a teammate at this task. It carries an identifier and
    // nothing else: no key, no token, no title. Whoever opens it still has to be signed in,
    // still has to be on the team, and still has to hold an endpoint somebody confirmed.
    privateLink(task) {
      return (global.harnessDesktop?.hubUrl || location.origin).replace(/\/$/, '') + '/t/' + task.id;
    }

    // ---- finishing, and handing over ----

    // Say the work itself is done, or that it is not going to be. Separate from any turn
    // finishing: an agent stopping is not a person deciding.
    async recordOutcome(task, outcome) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      return { outcome, ...await this.sendControl(task, 'task.outcome', { outcome: outcome === 'cancelled' ? 'cancelled' : 'completed' }) };
    }

    // Hand responsibility to somebody already on the project. This moves responsibility and
    // nothing else: not approval authority, not the host, not whose provider account pays.
    // The host refuses a recipient without project access rather than granting them any.
    async handOverResponsibility(task, { to, note }) {
      const writer = this.confirmedHost(task.runtimeId);
      if (!writer) throw Object.assign(new Error('host_unconfirmed'), { code: 'host_unconfirmed' });
      return { to, ...await this.sendControl(task, 'responsibility.handover', { to, ...(note ? { note: String(note) } : {}) }) };
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
