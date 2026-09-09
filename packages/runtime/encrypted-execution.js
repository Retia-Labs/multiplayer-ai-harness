'use strict';
// Runtime-owned execution: task contents and controls arrive only after EncryptedHost
// authenticates them. Provider state and approval grants remain on this machine.
const crypto = require('node:crypto');
const { TurnSession } = require('./session');
const { EncryptedTaskRun, eventId: runEventId } = require('./encrypted-run');
const { Events, Errors } = require('../protocol');
const { sameIdentity } = require('../e2ee/membership.mjs');
const { recoveryEpoch, requireRecoveryEpoch } = require('../protocol/recovery-epoch.mjs');

const refuse = (code, details = {}) => { throw Object.assign(new Error(code), { code, ...details }); };
const recoveryEventId = (task, turnId, part) => 'ev_' + crypto.createHash('sha256')
  .update(task.id + ':recovery:' + turnId + ':' + part).digest('hex').slice(0, 32);

class EncryptedExecution {
  constructor({ runtime, host }) {
    this.runtime = runtime;
    this.host = host;
    this.active = new Map();
    this.pending = new Set();
    this.taskCompletions = new Map();
    this.closed = false;
  }

  state(task) { return this.host.state.load('execution:' + task.id); }
  save(task, value) { this.host.state.save('execution:' + task.id, value); }

  approvalOwner() {
    const authority = this.runtime.approvalAuthority;
    if (!authority || (authority.teamId && authority.teamId !== this.runtime.teamId)) return null;
    if (recoveryEpoch(authority.recoveryEpoch) !== recoveryEpoch(this.host.membership?.recoveryEpoch)) return null;
    const verified = this.host.membership?.endpoints.find(endpoint => endpoint.state === 'verified' && sameIdentity(endpoint, authority));
    if (!verified) return null;
    return Object.fromEntries(['user', 'device', 'curve25519', 'ed25519'].map(key => [key, authority[key]]));
  }

  async applyMembership(current) {
    const completions = [];
    let failure;
    for (const [taskId, active] of this.active) {
      const authority = active.saved.approvalAuthority;
      if (!authority || !current.endpoints.some(endpoint => endpoint.state === 'revoked' && sameIdentity(endpoint, authority))) continue;
      // A grant belongs to this turn's locally appointed approver. Removing that
      // device cancels the turn before another workspace action can use its consent.
      try {
        active.saved.grants = {};
        this.save({ id: taskId }, active.saved);
        active.session.cancelPendingApprovals('approval_authority_revoked');
      } catch (error) { failure ||= error; }
      finally {
        try { active.session.interrupt(); } catch (error) { failure ||= error; }
      }
      const completion = this.taskCompletions.get(taskId);
      if (completion) completions.push(completion);
    }
    // A failing disk must not leave later tasks running. All affected sessions are
    // synchronously cancelled before surfacing a failure that prevents host receipt.
    if (failure) throw failure;
    await Promise.allSettled(completions);
  }

  async ensureTaskCreated(task, opened, provider) {
    if (opened.reader.seq !== 0) return;
    await opened.writer.append({ type: 'task.created', payload: {
      title: opened.objective.title, objective: opened.objective.objective,
      approvalOwner: this.approvalOwner(),
      ...(provider ? { provider } : {})
    } }, runEventId(task.id, 1));
  }

  async reconcile(task, opened) {
    const saved = this.state(task);
    const active = this.active.get(task.id);
    if (active) { active.session.expirePendingApprovals(); return; }
    if (!saved || (saved.state !== 'running' && saved.state !== 'recovery-required') || saved.recoveryLogged) return;
    // Older hosts could persist the execution marker before the creating event. Repair
    // that prefix before recording recovery, so the log remains replayable from zero.
    await this.ensureTaskCreated(task, opened, saved.settings?.provider);
    // A vanished process cannot establish which external effects finished. Persist that
    // uncertainty before accepting another command; never resume an action implicitly.
    const abandonedApprovals = { ...(saved.recoveryApprovals || {}), ...(saved.openApprovals || {}) };
    const unresolved = Object.fromEntries(opened.reader.state.approvals
      .filter(request => !opened.reader.state.decisions.some(decision => decision.basis === request.id))
      .map(request => [request.id, { ...request, requestId: request.id }]));
    for (const request of Object.values({ ...unresolved, ...abandonedApprovals })) {
      const settled = saved.settledApprovals?.[request.requestId];
      const decision = settled?.decision || 'cancel';
      const actor = settled?.by?.userId || 'execution-host';
      await opened.writer.append({ type: 'decision.recorded', payload: {
        actor, text: settled && decision !== 'cancel' ? 'Approval ' + decision
          : saved.failure ? 'Approval cancelled because encrypted history could not be recorded' : 'Approval expired after host restart',
        basis: request.requestId, turnId: request.turnId, decision,
        reason: saved.failure ? 'encrypted_log_unavailable' : 'host_restarted'
      } }, recoveryEventId(task, saved.turnId, request.requestId));
    }
    await opened.writer.append({ type: 'recovery.required', payload: {
      turnId: saved.turnId, reason: saved.failure ? 'encrypted_log_unavailable' : 'host_restarted',
      resumeSupported: !!saved.providerState?.codexAppServerThreadId
    } }, recoveryEventId(task, saved.turnId, 'required'));
    this.save(task, { ...saved, state: 'recovery-required', recoveryLogged: true, grants: {},
      abandonedApprovals, openApprovals: {} });
  }

  async startTask(task, opened, { input, settings = {}, by, commandId, acknowledgeUnknown = false, resumeProvider = false } = {}) {
    if (this.closed) refuse('host_stopped');
    if (this.active.has(task.id) || this.pending.has(task.id)) refuse('turn_already_running');
    if (opened.reader.state.outcome) refuse('task_already_settled');
    // Automatic first execution belongs to the encrypted creation request's epoch.
    // An explicit new command may continue old history after the customer reviews it.
    if (!commandId) requireRecoveryEpoch(opened.creationEpoch, this.host.membership?.recoveryEpoch);
    const epoch = recoveryEpoch(this.host.membership?.recoveryEpoch);
    const old = this.state(task);
    if (old?.state === 'running') {
      await this.reconcile(task, opened);
      refuse('recovery_required');
    }
    if (old?.state === 'recovery-required' && !acknowledgeUnknown) refuse('recovery_required');
    if (resumeProvider && (old?.state !== 'recovery-required' || !old?.providerState?.codexAppServerThreadId)) refuse('provider_resume_unavailable');
    const objective = opened.objective;
    const chosen = this.runtime.resolveSettings(old?.settings || {}, {
      provider: objective.provider || 'codex-cli', ...(objective.settings || {}), ...settings
    });
    const provider = this.runtime.provider(chosen.provider);
    const project = this.host.projects.get(task.projectId);
    if (!project || !this.runtime.isAuthorizedProject(project)) refuse('project_not_authorized');
    const requested = input || [{ type: 'text', text: objective.objective }];
    if (!Array.isArray(requested) || !requested.length || requested.some((item) =>
      item.type !== 'text' || typeof item.text !== 'string' || !item.text.trim())) refuse('invalid_agent_input');
    const actor = by || { userId: task.creatorUserId, name: task.creatorUserId };
    const turnId = 'turn_' + crypto.randomBytes(12).toString('hex');
    const thread = { id: task.id, cwd: project, settings: chosen,
      ...(old?.state === 'recovery-required' && !resumeProvider ? {} : (old?.providerState || {})) };
    const providerState = () => ({
      ...(thread.codexSessionId ? { codexSessionId: thread.codexSessionId } : {}),
      ...(thread.codexAppServerThreadId ? { codexAppServerThreadId: thread.codexAppServerThreadId } : {}),
      ...(thread.codexAccountBinding ? { codexAccountBinding: thread.codexAccountBinding } : {})
    });
    this.pending.add(task.id);
    try { await this.ensureTaskCreated(task, opened, provider.id); }
    catch (error) { this.pending.delete(task.id); throw error; }
    if (this.closed) { this.pending.delete(task.id); refuse('host_stopped'); }
    // Persist before the provider can execute. A crash from this point is an explicit
    // recovery-required state, even if no output made it back yet.
    const saved = { state: 'running', turnId, settings: chosen, openApprovals: {}, providerState: providerState(),
      approvalAuthority: this.approvalOwner(), recoveryEpoch: epoch,
      settledApprovals: old?.settledApprovals || {}, grants: {}, commandId: commandId || null };
    try { this.save(task, saved); }
    catch (error) { this.pending.delete(task.id); throw error; }
    const update = (change) => {
      if (this.closed) return;
      Object.assign(saved, change);
      this.save(task, saved);
    };
    let session, terminalStatus;
    const run = new EncryptedTaskRun({ opened, task, provider: provider.id, log: this.runtime.log,
      onAppendFailure: (error) => {
        try {
          update({ state: 'recovery-required', failure: error.code || 'encrypted_append_failed', grants: {},
            recoveryApprovals: { ...saved.openApprovals }, providerState: providerState() });
        } finally { session?.interrupt(); }
      },
      runTurn: async (emit) => {
        if (this.closed) refuse('host_stopped');
        requireRecoveryEpoch(epoch, this.host.membership?.recoveryEpoch);
        if (saved.approvalAuthority && !sameIdentity(saved.approvalAuthority, this.approvalOwner())) refuse('approval_authority_revoked');
        session = new TurnSession({ thread, turnId, by: actor, input: requested,
          provider, model: chosen.model, settings: chosen, executor: this.runtime.executor,
          history: opened.reader.state.messages.map((message) => ({ ...message,
            type: message.role === 'assistant' ? 'agentMessage' : 'userMessage' })),
          settledApprovals: Object.entries(saved.settledApprovals),
          onProviderStateChanged: () => update({ providerState: providerState() }),
          onApprovalRequested: (record) => update({ openApprovals: { ...saved.openApprovals, [record.requestId]: record } }),
          onApprovalSettled: (record) => {
            const { [record.requestId]: removed, ...openApprovals } = saved.openApprovals;
            const grants = Object.fromEntries(Object.entries(saved.grants).filter(([, grant]) => grant.requestId !== record.requestId));
            update({ openApprovals, grants, settledApprovals: { ...saved.settledApprovals, [record.requestId]: record } });
          },
          emit: (event) => {
            if (this.closed) return;
            if (event.method === Events.COMMAND_REQUEST_APPROVAL || event.method === Events.FILECHANGE_REQUEST_APPROVAL) {
              event = { ...event, approvalOwner: this.approvalOwner() };
            }
            emit(event);
            if (event.method === Events.TURN_STEER_DELIVERED) {
              const command = active.steers.get(event.steerSeq);
              if (command) active.run.append({ type: 'command.receipt', payload: {
                commandId: command.commandId, actor: command.sender, turnId,
                state: 'delivered', order: event.steerSeq
              } }).catch(() => session.interrupt());
            }
          }, log: this.runtime.log
        });
        const active = { session, run, steers: new Map(), saved };
        this.active.set(task.id, active);
        this.runtime.sessions.set(task.id, session);
        this.pending.delete(task.id);
        const result = await session.run();
        terminalStatus = result.status;
        update({ providerState: providerState(), grants: {} });
      }
    });
    // Keep the collector free to receive the very controls/approvals this turn awaits.
    const completion = run.start().then(() => {
      // Provider completion is not durable task completion. Keep the execution marker
      // running until the terminal event and every earlier append have reached storage.
      update({ state: terminalStatus, providerState: providerState(), grants: {} });
    }).catch((error) => {
      try { update({ state: 'recovery-required', failure: error.code || 'encrypted_execution_failed', grants: {}, providerState: providerState() }); }
      finally { session?.interrupt(); }
      this.runtime.log('encrypted execution needs recovery: ' + (error.code || 'encrypted_execution_failed'));
    }).finally(() => {
      this.active.delete(task.id); this.pending.delete(task.id);
      this.runtime.sessions.delete(task.id);
      if (this.taskCompletions.get(task.id) === completion) this.taskCompletions.delete(task.id);
    });
    this.completions ||= new Set();
    this.completions.add(completion);
    this.taskCompletions.set(task.id, completion);
    completion.then(() => this.completions.delete(completion), () => this.completions.delete(completion));
    return { turnId, state: 'accepted' };
  }

  async control(task, read, opened) {
    await this.reconcile(task, opened);
    const { action, payload, sender, senderDevice, commandId } = read;
    const by = { userId: sender, name: sender, device: senderDevice };
    if (action === 'task.diff') return { files: opened.reader.state.diffs, state: 'delivered' };
    if (action === 'turn.start') {
      const state = this.state(task);
      if (state?.state === 'recovery-required' && payload.acknowledgeUnknown !== true) refuse('recovery_required');
      return this.startTask(task, opened, { input: payload.input, settings: payload.settings, by, commandId,
        acknowledgeUnknown: payload.acknowledgeUnknown === true, resumeProvider: payload.resumeProvider === true });
    }
    if (action === 'approval.resolve') {
      const state = this.state(task);
      if (state?.abandonedApprovals?.[payload.requestId]) refuse(Errors.APPROVAL_STALE_AFTER_RESTART);
      const settled = state?.settledApprovals?.[payload.requestId];
      if (settled) refuse(settled.reason === 'approval_expired' ? Errors.APPROVAL_EXPIRED : Errors.APPROVAL_SETTLED, { settled });
    }
    const active = this.active.get(task.id);
    if (!active?.session.running) {
      if (action === 'approval.resolve' && this.state(task)?.abandonedApprovals?.[payload.requestId]) refuse(Errors.APPROVAL_STALE_AFTER_RESTART);
      refuse(Errors.TURN_NOT_ACTIVE);
    }
    const { session, saved } = active;
    const targetTurn = payload.expectedTurnId || payload.turnId;
    if (!targetTurn) refuse(Errors.TURN_BINDING_REQUIRED);
    if (targetTurn !== session.turnId) refuse(Errors.STALE_TURN);
    if (action === 'turn.steer') {
      if (!Array.isArray(payload.input) || !payload.input.length || payload.input.some((item) => item.type !== 'text' || typeof item.text !== 'string' || !item.text.trim())) refuse('invalid_agent_input');
      const result = session.steer(payload.input, by);
      active.steers.set(result.seq, { commandId, sender });
      await active.run.append({ type: 'command.receipt', payload: {
        commandId, actor: sender, turnId: session.turnId, state: 'queued', order: result.seq
      } });
      return { ...result, state: 'queued' };
    }
    if (action === 'turn.interrupt') {
      const result = session.requestInterrupt(by);
      return { ...result, interruptState: result.state, state: 'accepted' };
    }
    const owner = this.approvalOwner();
    const ownerMay = owner?.user === '@' + sender + ':plexus.local' && owner.device === senderDevice;
    if (action === 'approval.grant' || action === 'approval.revoke') {
      if (!ownerMay) refuse('host_owner_required');
      const recipient = payload.userId;
      if (!(await this.host.participants(task.projectId)).has(recipient)) refuse('recipient_not_in_project');
      if (action === 'approval.revoke') delete saved.grants[recipient];
      else {
        const expiresAt = payload.expiresAt;
        const request = session.pendingApprovals.get(payload.requestId);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 60 * 60 * 1000 ||
            typeof payload.requestId !== 'string' || !request || expiresAt > request.expiresAt) refuse('invalid_approval_scope');
        saved.grants[recipient] = { turnId: session.turnId, requestId: payload.requestId, expiresAt };
      }
      this.save(task, saved);
      await active.run.append({ type: action === 'approval.grant' ? 'approval.granted' : 'approval.revoked', payload: {
        by: sender, userId: recipient, requestId: payload.requestId || null, turnId: session.turnId,
        ...(action === 'approval.grant' ? { expiresAt: payload.expiresAt } : {})
      } });
      return { granted: action === 'approval.grant', userId: recipient };
    }
    if (action === 'approval.resolve') {
      const grant = saved.grants[sender];
      if (!ownerMay && (!grant || grant.turnId !== session.turnId || grant.requestId !== payload.requestId || grant.expiresAt <= Date.now())) refuse(Errors.NOT_APPROVER);
      return { settled: session.resolveApproval(payload.requestId, payload.decision, { ...by, approver: true }, {
        turnId: payload.turnId, fingerprint: payload.fingerprint
      }) };
    }
    refuse('unsupported_task_control');
  }

  async close() {
    this.closed = true;
    let failure;
    for (const { session } of this.active.values()) {
      try { session.interrupt(); } catch (error) { failure ||= error; }
    }
    await Promise.allSettled([...(this.completions || [])]);
    if (failure) throw failure;
  }
}

module.exports = { EncryptedExecution };
