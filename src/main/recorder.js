/**
 * Translates what the agent emits into events in the session log.
 *
 * This sits beside the existing emit path rather than replacing it. The
 * renderer keeps receiving exactly what it received before, so nothing in the
 * UI breaks, while the log quietly becomes the record everyone else reads from.
 * That matters because the emit stream is ephemeral and shaped for one local
 * window - it has no ordering anyone else can trust, and a watcher who joins
 * late has missed it. The log has both.
 *
 * The mapping is deliberately lossy. Streaming deltas are NOT recorded: forty
 * events per sentence would triple the log for something no one will ever read
 * back, and a watcher joining mid-run wants the message, not the typing. Only
 * completed items become facts.
 */
const { uid } = require('./log');

const AGENT = (name) => 'agent:' + (name || 'quorum');

class Recorder {
  constructor({ log, sessionId, agentName, humanName }) {
    this.log = log;
    this.sessionId = sessionId;
    this.agent = AGENT(agentName);
    this.human = 'human:' + (humanName || 'me');
    this.turnId = null;
    this.gateByCallId = new Map();
    this.stepStatus = new Map(); // stepId -> last status we recorded
  }

  _append(kind, actor, payload) {
    return this.log.append(this.sessionId, { kind, actor, payload })[0] || null;
  }

  /** Called once when a session is first opened. */
  start({ title, projectDir, branch, worktree, mode, model }) {
    this._append('session.started', this.human, {
      title: title || '',
      agent: this.agent.slice(6),
      owner: this.human.slice(6),
      mode
    });
    this._append('agent.joined', this.agent, { name: this.agent.slice(6), model: model || null });
    if (projectDir) {
      this._append('repo.bound', this.agent, { root: projectDir, branch: branch || null, worktree: worktree || null });
    }
  }

  /** The human's turn: what they asked for. */
  userTurn(text, images) {
    this.turnId = uid('turn');
    this._append('turn.started', this.human, {
      turnId: this.turnId,
      text: text || '',
      images: (images || []).length
    });
    return this.turnId;
  }

  /**
   * A directive is steering sent while a run is already moving, as opposed to
   * the message that started it. The agent queues these mid-loop, so they are
   * recorded as sent now and applied when the loop actually merges them.
   */
  directiveSent(text) {
    const id = uid('dir');
    this._append('directive.sent', this.human, { id, text: text || '' });
    return id;
  }

  directiveApplied(id) {
    this._append('directive.applied', this.agent, { id });
  }

  /** Map one agent emission onto zero or more log events. */
  record(ev) {
    if (!ev || !this.turnId) return;
    switch (ev.kind) {
      case 'item-done':
        this._item(ev.item);
        break;

      case 'item-update':
        // Only the plan is worth recording mid-flight: it is the one item whose
        // intermediate states a watcher actually needs, because it is how they
        // see where the run is going before it gets there.
        if (ev.item && ev.item.type === 'plan') this._plan(ev.item);
        break;

      case 'approval-request':
        this._gate(ev);
        break;

      case 'turn-done':
        if (ev.usage) {
          this._append('turn.finished', this.agent, { turnId: this.turnId, usage: ev.usage });
        } else {
          this._append('turn.finished', this.agent, { turnId: this.turnId, usage: null });
        }
        this.turnId = null;
        break;

      case 'turn-error':
        this._append('note.posted', 'system', { text: 'Turn ended: ' + (ev.error || 'error') });
        this._append('turn.finished', this.agent, { turnId: this.turnId, usage: ev.usage || null });
        this.turnId = null;
        break;

      default:
        break;
    }
  }

  _item(item) {
    if (!item) return;
    switch (item.type) {
      case 'message':
        if (item.text) this._append('turn.message', this.agent, { turnId: this.turnId, text: item.text });
        break;

      case 'reasoning':
        if (item.text) this._append('turn.reasoning', this.agent, { turnId: this.turnId, text: item.text });
        break;

      case 'plan':
        this._plan(item);
        break;

      case 'command':
        this._append('command.ran', this.agent, {
          cmd: item.command || '',
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
          ms: item.ms || 0,
          status: item.status || null
        });
        break;

      case 'edit':
        // A denied or failed write is still a fact about the run - arguably a
        // more interesting one than a successful write - so it is recorded with
        // its status rather than dropped.
        this._append('artifact.changed', this.agent, {
          path: item.path,
          status: item.status === 'done' ? (item.created ? 'added' : 'modified') : item.status,
          added: item.additions || 0,
          removed: item.deletions || 0
        });
        break;

      default:
        break;
    }
  }

  /**
   * The agent's plan uses its own vocabulary (pending / in_progress /
   * completed) keyed by position. The kernel wants stable ids so a step keeps
   * its history across the replans the agent does constantly.
   */
  _plan(item) {
    const steps = (item.steps || []).map((s, i) => ({
      id: 'step_' + i,
      title: s.step || s.title || '',
      status: s.status === 'completed' ? 'done' : s.status === 'in_progress' ? 'running' : 'queued'
    }));
    this._append('plan.set', this.agent, { steps, explanation: item.explanation || '' });

    // plan.set deliberately will not move a step backwards, so progress is
    // reported separately rather than smuggled into the plan payload.
    //
    // Only transitions are recorded. The agent re-sends its whole plan on every
    // update, so emitting on current status instead would write "step 1
    // finished" once per subsequent replan - which the reducer survives, but
    // which turns the log into something no person would read twice.
    for (const s of steps) {
      if (this.stepStatus.get(s.id) === s.status) continue;
      this.stepStatus.set(s.id, s.status);
      if (s.status === 'running') this._append('step.started', this.agent, { id: s.id });
      if (s.status === 'done') this._append('step.finished', this.agent, { id: s.id });
    }
  }

  _gate(ev) {
    const id = uid('gate');
    this.gateByCallId.set(ev.callId, id);
    this._append('gate.requested', this.agent, {
      id,
      callId: ev.callId,
      kind: ev.action === 'write' ? 'write' : 'command',
      subject: ev.command || '',
      risk: ev.action === 'write' ? 'write-outside-workspace' : 'unsafe-command'
    });
  }

  /** Someone answered a gate. Who, is the part that matters. */
  gateResolved(callId, approved, byName) {
    const id = this.gateByCallId.get(callId);
    if (!id) return;
    this.gateByCallId.delete(callId);
    this._append('gate.resolved', 'human:' + (byName || this.human.slice(6)), { id, approved: !!approved });
  }

  handOff(to, note) {
    this._append('run.handed_off', this.human, { to, note: note || null });
  }

  claimStep(id, byName) {
    this._append('step.claimed', 'human:' + (byName || this.human.slice(6)), { id });
  }

  releaseStep(id, byName) {
    this._append('step.released', 'human:' + (byName || this.human.slice(6)), { id });
  }

  note(text, byName) {
    this._append('note.posted', 'human:' + (byName || this.human.slice(6)), { text });
  }

  seen(byName) {
    this._append('presence.seen', 'human:' + (byName || this.human.slice(6)), {});
  }

  modeSet(mode) {
    this._append('mode.set', this.human, { mode });
  }

  paused(reason) {
    this._append('run.paused', this.human, { reason: reason || null });
  }

  resumed() {
    this._append('run.resumed', this.human, {});
  }
}

module.exports = { Recorder };
