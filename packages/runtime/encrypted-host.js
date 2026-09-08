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
const { createDurableEndpoint } = require('./durable-endpoint');
const { replayMembership, verifySignature, currentMembershipBody, accountId } = require('../e2ee/membership.mjs');
const { canonical, roomFor } = require('../protocol/encrypted-task.mjs');
const { HubKeyTransport } = require('../e2ee/hub-key-transport.mjs');
const { EncryptedTaskTransport } = require('../e2ee/task-log.mjs');
const { matrixUser } = require('../protocol/encrypted-task.mjs');
const { readTaskControl, sendTaskReceipt, ENVELOPE_TYPE, HISTORY_TYPE } = require('../e2ee/task-control.mjs');
const { normalizeLink, normalizeLinkTitle } = require('../protocol/related-work.mjs');
const { routing } = require('../e2ee/task-log.mjs');
const { EncryptedTaskState, EncryptedFixtureHost } = require('./encrypted-task');
const { EncryptedTaskRun } = require('./encrypted-run');
const { FreshnessAuthority } = require('./freshness-authority');
const { recoveryEpoch, requireRecoveryEpoch } = require('../protocol/recovery-epoch.mjs');
// Match the relay's answer window. Start locally before POST so a delayed request
// never makes this endpoint retain a nonce longer than the relay accepts it.
const MEMBERSHIP_CHALLENGE_TTL_MS = 60000;

class EncryptedHost {
  constructor({ runtime, url, statePath, projects = new Map(), device = 'HOST', authority = null, endpointFactory = createDurableEndpoint, onControl = null, log = () => {} }) {
    this.runtime = runtime;
    this.authority = authority;
    this.endpointFactory = endpointFactory;
    this.onControl = onControl;
    this.reconciled = false;
    this.challenge = null;
    this.challengeExpiresAt = 0;
    this.reconcileGeneration = 0;
    this.observedMembership = null;
    this.openedTasks = new Map();
    this.controlQueues = new Map();
    this.keyShareQueue = Promise.resolve();
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

  static identityDurability() { return { persistent: true, backend: 'desktop-os-sealed-indexeddb' }; }

  async start() {
    if (!this.runtime.teamId) throw new Error('runtime_unpaired');
    this.state = new EncryptedTaskState(this.statePath);
    this.freshness = this.authority ? new FreshnessAuthority({ state: this.state, teamId: this.runtime.teamId,
      runtimeId: this.runtime.id, genesis: this.authority }) : null;
    this.freshness?.record(); // Corrupt or foreign local pins never fall back to genesis.
    this.endpoint = await this.endpointFactory({
      user: matrixUser(this.runtime.id),
      device: this.device,
      transport: new HubKeyTransport({ url: this.url, token: this.runtime.runtimeToken, device: this.device, runtimeId: this.runtime.id })
    });
    this.tasks = new EncryptedTaskTransport({ url: this.url, token: this.runtime.runtimeToken, runtimeId: this.runtime.id });
    this.log('encrypted host endpoint published as ' + this.endpoint.identity().device);
    return this.endpoint.identity();
  }

  disconnect() {
    this.reconciled = false; this.challenge = null; this.challengeExpiresAt = 0;
    this.reconcileGeneration++;
  }

  async enrollmentRequest(path = '', body) {
    const response = await fetch(this.url + '/api/enrollment' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + this.runtime.runtimeToken, 'X-Plexus-Runtime': this.runtime.id,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Object.assign(new Error('enrollment_unavailable'), { code: 'enrollment_unavailable' });
    return response.json();
  }

  async beginReconcile() {
    if (this.freshness?.record()?.state === 'revoked') {
      throw Object.assign(new Error('membership_freshness_authority_revoked'), { code: 'membership_freshness_authority_revoked' });
    }
    this.reconciled = false;
    const generation = ++this.reconcileGeneration;
    const challenge = this.challenge = crypto.randomBytes(24).toString('hex');
    this.challengeExpiresAt = Date.now() + MEMBERSHIP_CHALLENGE_TTL_MS;
    try {
      const context = this.freshness?.context();
      await this.enrollmentRequest('/challenge', { teamId: this.runtime.teamId, challenge,
        ...(context ? { signer: this.freshness.signer(), activationId: context.activationId } : {}) });
    } catch (error) {
      if (generation === this.reconcileGeneration) { this.challenge = null; this.challengeExpiresAt = 0; }
      throw error;
    }
    if (generation !== this.reconcileGeneration) throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
    return challenge;
  }

  async readMembership() {
    if (!this.authority) throw Object.assign(new Error('membership_authority_required'), { code: 'membership_authority_required' });
    const received = await this.enrollmentRequest('?team=' + encodeURIComponent(this.runtime.teamId));
    const current = await replayMembership(received.authorityLog, { teamId: this.runtime.teamId,
      authority: this.authority, service: new URL(this.url).origin, checkpoint: this.state.load('authorization:' + this.runtime.teamId) });
    this.checkMembershipFloor(current, received.authorityLog);
    // Retain authenticated observations even if the subsequent SQLite write fails.
    // A recovered disk cannot make this live host forget a removal it already saw.
    this.observedMembership = { seq: current.seq, hash: current.hash };
    return { received, current };
  }

  checkMembershipFloor(current, records) {
    // Signature verification awaits the SDK. Another request may apply a newer
    // checkpoint during it; that must not be overwritten by this older response.
    for (const floor of [this.state.load('authorization:' + this.runtime.teamId), this.observedMembership]) {
      if (floor && (current.seq < floor.seq || (current.seq === floor.seq ? current.hash !== floor.hash :
        records[floor.seq]?.previous !== floor.hash))) {
        throw Object.assign(new Error('membership_rollback'), { code: 'membership_rollback' });
      }
    }
  }

  async prepareFreshnessAuthority(candidate) {
    if (!this.freshness) throw Object.assign(new Error('freshness_host_unavailable'), { code: 'freshness_host_unavailable' });
    const { current } = await this.readMembership();
    return this.freshness.prepare(candidate, current, this.reconcileGeneration);
  }

  async commitFreshnessAuthority(proposalId, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
    if (!this.freshness) throw Object.assign(new Error('freshness_host_unavailable'), { code: 'freshness_host_unavailable' });
    const { current } = await this.readMembership();
    beforeCommit();
    const result = this.freshness.commit(proposalId, current, this.reconcileGeneration);
    this.membership = current;
    this.disconnect();
    afterCommit();
    return result;
  }

  async reconcileMembership() {
    if (!this.authority) throw Object.assign(new Error('membership_authority_required'), { code: 'membership_authority_required' });
    if (this.freshness?.record()?.state === 'revoked') {
      this.disconnect();
      await this.runtime.encryptedExecution?.close();
      throw Object.assign(new Error('membership_freshness_authority_revoked'), { code: 'membership_freshness_authority_revoked' });
    }
    const generation = this.reconcileGeneration;
    const challenge = this.challenge;
    const needsProof = !this.reconciled;
    const key = 'authorization:' + this.runtime.teamId;
    let received, current;
    try {
      ({ received, current } = await this.readMembership());
      if (this.freshness?.requiresRecovery(current)) {
        this.membership = current;
        this.disconnect();
        // A valid customer recovery claim is public membership evidence. It is not
        // consent to resume this host. Retain the floor even while awaiting consent.
        try { this.state.save(key, { seq: current.seq, hash: current.hash }); }
        finally { await this.runtime.encryptedExecution?.close(); }
        throw Object.assign(new Error('membership_owner_recovery_required'), { code: 'membership_owner_recovery_required' });
      }
      if (this.freshness?.isRevoked(current)) {
        this.membership = current;
        // Applying removal must stop execution before a relay gets another chance
        // to withhold a response. Every entry point, not just polling, observes it.
        this.disconnect();
        try { this.freshness.markRevoked(current); }
        finally {
          try { await this.runtime.encryptedExecution?.applyMembership?.(current); }
          finally { await this.runtime.encryptedExecution?.close(); }
        }
        throw Object.assign(new Error('membership_freshness_authority_revoked'), { code: 'membership_freshness_authority_revoked' });
      }
      const signer = this.freshness?.signer() || this.authority;
      const context = this.freshness?.context();
      if (context && !this.freshness.verifiedSigner(current)) {
        throw Object.assign(new Error('freshness_candidate_unverified'), { code: 'freshness_candidate_unverified' });
      }
      if (generation !== this.reconcileGeneration) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      // Read authenticated removals before asking a selected signer to answer. The
      // relay correctly refuses a revoked signer, but that must not prevent this
      // host from applying the removal when it reconnects with an older active pin.
      if (needsProof && (!challenge || Date.now() >= this.challengeExpiresAt)) {
        await this.beginReconcile();
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      if (needsProof) {
        const proof = received.currentProof;
        const body = currentMembershipBody(this.runtime.teamId, challenge, current, context);
        // An owner may answer just before a project/grant advances the signed log.
        // The relay hides answered challenges, so renew an authenticated ancestor
        // proof now; accepting it or waiting for nonce expiry would be incorrect.
        if (proof?.challenge === challenge && proof.teamId === this.runtime.teamId && proof.type === body.type &&
            Number.isSafeInteger(proof.seq) && proof.seq > 0 && proof.seq < current.seq &&
            received.authorityLog[proof.seq]?.previous === proof.hash &&
            await verifySignature(signer, currentMembershipBody(this.runtime.teamId, challenge, proof, context), proof.signature)) {
          if (generation === this.reconcileGeneration && this.challenge === challenge &&
              !this.reconciled && Date.now() < this.challengeExpiresAt) await this.beginReconcile();
          throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
        }
        if (!proof || proof.seq !== current.seq || proof.hash !== current.hash || proof.challenge !== challenge ||
            proof.teamId !== this.runtime.teamId || proof.type !== body.type ||
            (context && (proof.runtimeId !== context.runtimeId || proof.activationId !== context.activationId)) ||
            !await verifySignature(signer, body, proof.signature)) throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      // Disconnect or nonce renewal invalidates every earlier in-flight response.
      // A signed answer received after its window ends must use the next challenge.
      if (generation !== this.reconcileGeneration || (needsProof && Date.now() >= this.challengeExpiresAt)) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      this.checkMembershipFloor(current, received.authorityLog);
      this.membership = current;
      try { this.state.save(key, { seq: current.seq, hash: current.hash }); }
      catch (error) {
        // Failed checkpoint storage cannot leave already observed removals waiting
        // while active providers continue. Cancel before reporting the disk error.
        this.disconnect();
        try { await this.runtime.encryptedExecution?.applyMembership?.(current); }
        finally { await this.runtime.encryptedExecution?.close(); }
        throw error;
      }
      await this.runtime.encryptedExecution?.applyMembership?.(current);
      // Cancellation flushes encrypted receipts asynchronously. Another request
      // may advance the floor or disconnect while those appends are in flight.
      if (generation !== this.reconcileGeneration || (needsProof && Date.now() >= this.challengeExpiresAt)) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      this.checkMembershipFloor(current, received.authorityLog);
      await this.finishOwnerRecovery(current);
      if (generation !== this.reconcileGeneration || (needsProof && Date.now() >= this.challengeExpiresAt)) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      this.checkMembershipFloor(current, received.authorityLog);
    } catch (error) { if (generation === this.reconcileGeneration) this.reconciled = false; throw error; }
    this.reconciled = true;
    return current;
  }

  async finishOwnerRecovery(current) {
    const epoch = recoveryEpoch(current.recoveryEpoch);
    if (!epoch) return;
    const key = 'recovery:' + this.runtime.teamId;
    const pending = this.state.load(key);
    if (!pending || pending.version !== 1 || pending.epoch !== epoch ||
        !['rotation-pending', 'active'].includes(pending.state)) {
      throw Object.assign(new Error('membership_owner_recovery_required'), { code: 'membership_owner_recovery_required' });
    }
    if (pending.state === 'active') return;
    // A concurrent reconciliation must join the barrier, not share before rotation
    // or mark a partially rotated set complete. A failure leaves the durable barrier.
    if (this.recoveryRotation) return this.recoveryRotation;
    const generation = this.reconcileGeneration;
    this.recoveryRotation = (async () => {
      if (this.runtime.encryptedExecution?.active?.size || this.runtime.encryptedExecution?.pending?.size) {
        throw Object.assign(new Error('freshness_host_busy'), { code: 'freshness_host_busy' });
      }
      const ids = new Set([...this.state.taskIds(), ...this.openedTasks.keys()]);
      await this.queueKeyShare(async () => {
        for (const id of ids) {
          await this.endpoint.shareVerifiedTaskKey(roomFor(id), [this.endpoint.identity()], { rotate: true });
        }
      }, { allowPending: true });
      if (generation !== this.reconcileGeneration || this.freshness.requiresRecovery(current)) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      const writes = [];
      for (const id of ids) {
        const executionKey = 'execution:' + id, saved = this.state.load(executionKey);
        if (!saved) continue;
        // Host-local checkpoints and dedupe stay. A recovered epoch starts fresh
        // provider sessions and never restores a saved approval or uncertain action.
        writes.push([executionKey, { ...saved, grants: {}, approvalAuthority: null, providerState: {},
          abandonedApprovals: { ...saved.abandonedApprovals, ...saved.openApprovals }, openApprovals: {},
          ...(saved.state === 'running' ? { state: 'recovery-required', recoveryLogged: false } : {}) }]);
      }
      writes.push([key, { ...pending, state: 'active' }]);
      this.state.saveMany(writes);
      this.handedOff.clear();
    })();
    try { await this.recoveryRotation; }
    finally { this.recoveryRotation = null; }
  }

  async verifiedEndpointList() {
    const current = await this.reconcileMembership();
    const out = [];
    for (const row of current.endpoints) {
      if (row.state !== 'verified') continue;
      const identity = Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map((key) => [key, row[key]]));
      await this.endpoint.confirmEndpoint(identity, { confirmed: true });
      out.push({ userId: row.userId, identity });
    }
    return out;
  }

  queueKeyShare(work, { allowPending = false } = {}) {
    const generation = this.reconcileGeneration;
    const operation = this.keyShareQueue.then(() => {
      if (generation !== this.reconcileGeneration || (!allowPending && !this.reconciled)) {
        throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
      }
      return work();
    });
    this.keyShareQueue = operation.catch(() => {});
    return operation;
  }

  shareTaskKeys(task, room, members, options = {}) {
    const epoch = recoveryEpoch(this.membership?.recoveryEpoch);
    return this.queueKeyShare(() => {
      requireRecoveryEpoch(epoch, this.membership?.recoveryEpoch);
      for (const member of members) {
        if (member.user === this.endpoint.identity().user && member.device === this.endpoint.identity().device) continue;
        if (!this.membership.endpoints.some(row => row.state === 'verified' &&
            ['user', 'device', 'ed25519', 'curve25519'].every(key => row[key] === member[key])) ||
            !this.membership.grants.some(row => !row.revoked && row.projectId === task.projectId && matrixUser(row.userId) === member.user)) {
          throw Object.assign(new Error('member_endpoint_unverified'), { code: 'member_endpoint_unverified' });
        }
      }
      return this.endpoint.shareVerifiedTaskKey(room, members, options);
    });
  }

  async verifiedEndpoints() {
    return new Map((await this.verifiedEndpointList()).map(({ userId, identity }) => [userId, identity]));
  }

  async pending() {
    const listed = await this.tasks.list(this.runtime.teamId);
    return (listed.tasks || []).filter((task) => task.runtimeId === this.runtime.id && !this.handled.has(task.id) && !this.state.load('execution:' + task.id));
  }

  async participants(projectId) {
    const current = await this.reconcileMembership();
    return new Map(current.grants.filter((g) => g.projectId === projectId && !g.revoked).map((g) => [g.userId, g]));
  }

  async openTask(task) {
    if (!this.openedTasks.has(task.id)) {
      const opening = (async () => {
        const project = this.projects.get(task.projectId);
        if (!project) throw new Error('project_not_mapped');
        const current = await this.reconcileMembership();
        const creator = current.endpoints.find((e) => e.userId === task.creatorUserId && e.curve25519 === task.request?.content?.sender_key);
        if (!creator) throw new Error('task_creator_unverified');
        const previouslyStarted = this.state.load(task.id)?.checkpoint?.seq > 0;
        if (!previouslyStarted && (creator.state !== 'verified' || !current.grants.some((g) => g.projectId === task.projectId && g.userId === task.creatorUserId && !g.revoked))) {
          throw new Error('task_creator_unverified');
        }
        await this.endpoint.confirmEndpoint(creator, { confirmed: true });
        const adapter = new EncryptedFixtureHost({ runtime: this.runtime, endpoint: this.endpoint,
          transport: this.tasks, state: this.state, projects: this.projects,
          creators: new Map([[task.creatorUserId, creator]]),
          shareTaskKeys: (room, members, options) => this.shareTaskKeys(task, room, members, options),
          authorizeCreation: async event => {
            const latest = await this.reconcileMembership();
            const epoch = recoveryEpoch(event.content?.recoveryEpoch);
            if ((event.content?.type === 'task.create.v1') !== (epoch === null)) {
              throw Object.assign(new Error('invalid_recovery_epoch'), { code: 'invalid_recovery_epoch' });
            }
            requireRecoveryEpoch(epoch, latest.recoveryEpoch);
            const activeCreator = latest.endpoints.find(row => row.userId === task.creatorUserId && row.device === event.senderDevice);
            if (activeCreator?.state !== 'verified' || !latest.grants.some(row => !row.revoked && row.projectId === task.projectId && row.userId === task.creatorUserId)) {
              throw Object.assign(new Error('task_creator_unverified'), { code: 'task_creator_unverified' });
            }
          } });
        const opened = await adapter.open(task);
        return { ...opened, adapter };
      })();
      this.openedTasks.set(task.id, opening);
      opening.catch(() => { if (this.openedTasks.get(task.id) === opening) this.openedTasks.delete(task.id); });
    }
    return this.openedTasks.get(task.id);
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
    const members = (await this.verifiedEndpointList()).filter((member) => holders.has(member.userId));
    if (!members.length) return { admitted: [] };
    const { adapter } = await this.openTask(task);

    // History first. A teammate admitted to the session but not handed what came before
    // would replay from event one and fail on the first event they cannot decrypt.
    const handed = [];
    for (const member of members) {
      const key = task.id + '/' + member.identity.user + '/' + member.identity.device;
      if (this.handedOff.has(key)) continue;
      const envelopeEpoch = recoveryEpoch(this.membership?.recoveryEpoch);
      const history = await adapter.handOff(task, { userId: member.userId, device: member.identity.device });
      const envelope = await this.endpoint.sealControl(member.identity.user, member.identity.device, {
        ...this.historyContext(), task: routing(task), history
      });
      const current = await this.reconcileMembership();
      requireRecoveryEpoch(envelopeEpoch, current.recoveryEpoch);
      if (!current.endpoints.some(row => row.state === 'verified' && row.user === member.identity.user && row.device === member.identity.device) ||
          !current.grants.some(row => !row.revoked && row.projectId === task.projectId && row.userId === member.userId)) continue;
      await this.endpoint.transport.deliverToDevice(member.identity.user, member.identity.device, envelope);
      this.handedOff.add(key);
      handed.push(member.userId);
    }
    // Then the session itself, so everything written afterwards needs no further handoff.
    const latest = await this.reconcileMembership();
    const eligible = members.filter(member => latest.endpoints.some(row => row.state === 'verified' && row.user === member.identity.user && row.device === member.identity.device) &&
      latest.grants.some(row => !row.revoked && row.projectId === task.projectId && row.userId === member.userId));
    if (eligible.length) await adapter.admit(task, eligible.map(member => member.identity));
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
    let current, hostOnly = false;
    try { current = await this.reconcileMembership(); }
    catch (error) {
      if (error.code !== 'membership_freshness_authority_revoked') throw error;
      // Reconciliation already cancelled execution. Reuse the authenticated head
      // that caused removal; a second fetch must not be a prerequisite for applying it.
      current = this.membership;
      const floor = this.state.load('authorization:' + this.runtime.teamId);
      if (!current || current.seq < floor.seq || (current.seq === floor.seq && current.hash !== floor.hash)) {
        ({ current } = await this.readMembership());
        this.freshness.markRevoked(current);
        this.membership = current;
      }
      hostOnly = true;
    }
    const marker = 'revocations:' + this.runtime.teamId;
    const saved = this.state.load(marker) || { seq: 0, pendingAcks: [] };
    const through = saved.seq;
    const pending = current.revocations.filter((r) => r.seq > through);
    if (!pending.length && !saved.pendingAcks?.length) return { applied: [], rotated: [], requiresAuthority: hostOnly };
    const listed = tasks || (await this.tasks.list(this.runtime.teamId)).tasks || [];
    const owned = listed.filter((task) => task.runtimeId === this.runtime.id && this.projects.has(task.projectId));
    const rotated = [];
    if (pending.length) {
      // Include durable checkpoints from before this process started. The relay
      // cannot skip a room by omitting its task during a restart and later return it.
      await this.queueKeyShare(async () => {
        for (const id of new Set([...owned.map(task => task.id), ...this.state.taskIds(), ...this.openedTasks.keys()])) {
          await this.endpoint.shareVerifiedTaskKey(roomFor(id), [this.endpoint.identity()], { rotate: true });
          rotated.push(id);
        }
      }, { allowPending: hostOnly });
    }
    for (const task of pending.length && !hostOnly ? owned : []) {
      const holders = await this.participants(task.projectId);
      const members = (await this.verifiedEndpointList()).filter((m) => holders.has(m.userId)).map((m) => m.identity);
      const { adapter } = await this.openTask(task);
      // Rotation above covered every durable room. Re-share only to current members
      // of tasks available now; omitted rooms stay host-only until admitted later.
      await adapter.admit(task, [this.endpoint.identity(), ...members]);
    }
    // Commit locally before acknowledging. The relay cannot manufacture this application state.
    const pendingAcks = [...(saved.pendingAcks || []), ...pending];
    this.state.save(marker, { seq: current.seq, pendingAcks });
    const applied = [];
    for (const revocation of pendingAcks) {
      if (revocation.device) {
        const ack = { type: 'plexus.membership.applied.v1', teamId: this.runtime.teamId, runtimeId: this.runtime.id, seq: current.seq, hash: current.hash,
          target: { userId: revocation.userId, device: revocation.device }, signer: this.endpoint.identity() };
        await this.enrollmentRequest('/ack-revocation', { ...ack, signature: await this.endpoint.sign(canonical(ack)) });
      }
      applied.push(revocation);
      this.state.save(marker, { seq: current.seq, pendingAcks: pendingAcks.filter((entry) => !applied.includes(entry)) });
    }
    return { applied, rotated, requiresAuthority: hostOnly };
  }

  // Control messages teammates have sealed to this host, applied to the tasks they name.
  //
  // The mailbox is drained once and dispatched, because draining is destructive: collecting
  // "for one task" would throw away every message addressed to the others. Poll-based like
  // pending() - a request is picked up when the host next looks, and there is no push.
  async collect() {
    await this.reconcileMembership();
    await this.verifiedEndpointList();
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
        const result = await this.apply(match.task, match.read);
        applied.push(result);
        await sendTaskReceipt(this.endpoint, { user: matrixUser(match.read.sender), device: match.read.senderDevice }, {
          task: match.task, commandId: match.read.commandId, state: result?.state || 'delivered', result,
          recoveryEpoch: match.read.recoveryEpoch
        });
      } catch (error) {
        this.log('task control refused: ' + (error.code || error.message));
        const code = error.code || error.message || 'task_control_refused';
        refused.push({ taskId: match.task.id, commandId: match.read.commandId, code });
        try { await sendTaskReceipt(this.endpoint, { user: matrixUser(match.read.sender), device: match.read.senderDevice }, {
          task: match.task, commandId: match.read.commandId, state: code === 'command_outcome_unknown' ? 'unknown' : 'rejected', code,
          recoveryEpoch: match.read.recoveryEpoch,
          ...(error.settled ? { result: { settled: error.settled } } : {})
        }); } catch {}
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
    const current = await this.reconcileMembership();
    return current.endpoints.find((e) => e.userId === userId && e.device === device)?.state || 'unknown';
  }

  apply(task, read) {
    const work = (this.controlQueues.get(task.id) || Promise.resolve()).then(() => this.applyOrdered(task, read)).catch((error) => {
      const key = 'control:' + task.id + ':' + read.commandId;
      const held = this.state.load(key);
      // Typed policy/validation refusals are final. Unknown dispatch failures retain the
      // accepted claim so retry can never silently execute the action a second time.
      if (held?.state === 'accepted' && error.code && !['command_outcome_unknown', 'crypto_broker_unavailable'].includes(error.code)) {
        this.state.save(key, { ...held, state: 'rejected', refusal: { code: error.code, ...(error.settled ? { settled: error.settled } : {}) } });
      }
      throw error;
    });
    this.controlQueues.set(task.id, work.catch(() => {}));
    return work;
  }

  // One authorized control message, turned into one log event.
  async applyOrdered(task, read) {
    const { sender, senderDevice, action, payload, commandId } = read;
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
    requireRecoveryEpoch(read.recoveryEpoch, this.membership?.recoveryEpoch);

    const opened = await this.openTask(task);
    requireRecoveryEpoch(read.recoveryEpoch, this.membership?.recoveryEpoch);
    if (!this.reconciled) throw Object.assign(new Error('membership_reconciliation_required'), { code: 'membership_reconciliation_required' });
    const commandKey = 'control:' + task.id + ':' + commandId;
    const fingerprint = canonical(read);
    const previous = this.state.load(commandKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('command_id_conflict'), { code: 'command_id_conflict' });
      if (previous.refusal) throw Object.assign(new Error(previous.refusal.code), previous.refusal);
      if (previous.result) return { ...previous.result, duplicate: true };
      throw Object.assign(new Error('command_outcome_unknown'), { code: 'command_outcome_unknown' });
    }
    if (!commandId) throw Object.assign(new Error('invalid_command_id'), { code: 'invalid_command_id' });
    this.state.save(commandKey, { fingerprint, state: 'accepted' });
    if (action === 'task.history') {
      if (Object.keys(payload).length) throw Object.assign(new Error('invalid_task_control'), { code: 'invalid_task_control' });
      // Reissue consumed/lost Olm ciphertext only to the authenticated requester.
      // A new command identity asks for a fresh handoff; retrying the same identity
      // retains the normal command result without pretending the recipient read it.
      const history = await opened.adapter.handOff(task, { userId: sender, device: senderDevice });
      const envelope = await this.endpoint.sealControl(matrixUser(sender), senderDevice, {
        ...this.historyContext(), task: routing(task), history
      });
      // Export and encryption await the SDK. Recheck the authenticated state before
      // publishing, so a removal applied during that work cannot receive new keys.
      const current = await this.reconcileMembership();
      requireRecoveryEpoch(read.recoveryEpoch, current.recoveryEpoch);
      const recipient = current.endpoints.find(endpoint => endpoint.userId === sender && endpoint.device === senderDevice);
      if (recipient?.state !== 'verified') {
        const code = recipient?.state === 'revoked' ? 'endpoint_revoked' : 'endpoint_not_verified';
        throw Object.assign(new Error(code), { code });
      }
      if (!current.grants.some(grant => grant.projectId === task.projectId && grant.userId === sender && !grant.revoked)) {
        throw Object.assign(new Error('sender_not_in_project'), { code: 'sender_not_in_project' });
      }
      await this.endpoint.transport.deliverToDevice(matrixUser(sender), senderDevice, envelope);
      const result = { taskId: task.id, type: 'task.history', state: 'accepted', history: 'submitted' };
      this.state.save(commandKey, { fingerprint, state: 'completed', result });
      return result;
    }
    if (action.startsWith('turn.') || action.startsWith('approval.') || action === 'task.diff') {
      if (!this.onControl) throw Object.assign(new Error('unsupported_task_control'), { code: 'unsupported_task_control' });
      const result = await this.onControl(task, read, opened);
      this.state.save(commandKey, { fingerprint, state: 'completed', result });
      return result;
    }
    // Help requests carry their own id; an outcome or a handover is identified by what it
    // is and who sent it, which is enough to make a redelivered envelope idempotent without
    // letting a caller choose the identity of an event it does not own.
    const id = ['help.request', 'help.settle', 'link.add', 'link.remove'].includes(action)
      ? String(payload.id || '')
      : commandId;
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
    const result = { taskId: task.id, type: event.type, id, state: 'delivered' };
    this.state.save(commandKey, { fingerprint, state: 'completed', result });
    return result;
  }

  historyContext() {
    const epoch = recoveryEpoch(this.membership?.recoveryEpoch);
    return epoch ? { type: 'plexus.task.history.v2', recoveryEpoch: epoch } : { type: HISTORY_TYPE };
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
      const opened = await this.openTask(task);
      const adapter = opened.adapter;
      // Drain anything the hub is holding for this endpoint before writing: the creator's
      // session keys arrive the same way as everything else.
      const run = new EncryptedTaskRun({ opened, task, runTurn, provider, log: this.log });
      const result = await run.start();
      this.handled.add(id);
      return { ...result, adapter, opened };
    })().finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }

  close() {
    if (!this.closing) this.closing = (async () => {
      this.disconnect();
      await Promise.allSettled([...this.controlQueues.values()]);
      await this.keyShareQueue;
      try { await this.endpoint?.close(); } finally { this.state?.close(); }
    })();
    return this.closing;
  }

}

module.exports = { EncryptedHost };
