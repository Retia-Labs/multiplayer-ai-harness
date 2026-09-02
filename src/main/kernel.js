/**
 * The session kernel: a pure reducer from an event log to the state the UI
 * draws.
 *
 * Ported from Quorum's src/lib/kernel.ts, narrowed to what a coding session
 * needs. The rule that makes multiplayer work is that nothing outside this file
 * decides what the session looks like. Both the local agent and a remote
 * watcher run the same events through the same reducer and get the same
 * answer, so "what is happening right now" is never negotiated between
 * processes - it is derived.
 *
 * Everything here must stay pure: no clock, no disk, no randomness. Replaying
 * the same events must produce an identical state, or the log stops being
 * evidence of anything.
 */

/** Actors are "agent:<name>" | "human:<name>" | "system". */
function actorName(actor) {
  const i = actor.indexOf(':');
  return i === -1 ? actor : actor.slice(i + 1);
}

function actorKind(actor) {
  if (actor.startsWith('agent:')) return 'agent';
  if (actor.startsWith('human:')) return 'human';
  return 'system';
}

const EVENT_KINDS = [
  'session.started',
  'repo.bound',
  'mode.set',
  'agent.joined',
  'presence.seen',
  'plan.set',
  'step.added',
  'step.started',
  'step.output',
  'step.finished',
  'turn.started',
  'turn.reasoning',
  'turn.message',
  'turn.finished',
  'directive.sent',
  'directive.applied',
  'directive.honored',
  'gate.requested',
  'gate.resolved',
  'artifact.changed',
  'command.ran',
  'cost.reported',
  'note.posted',
  'run.paused',
  'run.resumed',
  'run.finished',
  'run.handed_off',
  'step.claimed',
  'step.released'
];

function emptyState(id) {
  return {
    id,
    title: '',
    goal: '',
    repo: null,
    agent: '',
    owner: '',
    /**
     * Who currently holds the wheel. Without this, two people send
     * contradictory directives into the same context and the agent simply
     * obeys whichever arrived last - the run does what neither of them asked
     * for and the log cannot say why.
     */
    driver: null,
    handoffs: [],
    status: 'running',
    mode: 'agent',
    steps: [],
    turns: [],
    directives: [],
    gates: [],
    notes: [],
    people: [],
    agents: [],
    artifacts: [],
    changes: [],
    commands: [],
    git: null,
    costUsd: 0,
    startedAt: null,
    endedAt: null,
    pausedReason: null,
    lastSeq: 0
  };
}

function touchPerson(s, actor, ts) {
  if (actorKind(actor) !== 'human') return;
  const name = actorName(actor);
  const found = s.people.find((p) => p.name === name);
  if (found) found.lastSeen = ts;
  else s.people.push({ name, firstSeen: ts, lastSeen: ts });
}

function findStep(s, id) {
  return s.steps.find((x) => x.id === id) || null;
}

/**
 * Apply one event. Unknown kinds are ignored rather than thrown on: an older
 * client must survive reading a log written by a newer one, otherwise every
 * schema addition is a hard break for anyone who has not updated.
 */
function apply(s, e) {
  const p = e.payload || {};
  s.lastSeq = Math.max(s.lastSeq, e.seq);
  touchPerson(s, e.actor, e.ts);

  switch (e.kind) {
    case 'session.started':
      s.title = p.title || s.title;
      s.goal = p.goal || s.goal;
      s.repo = p.repo ?? s.repo;
      s.agent = p.agent || s.agent;
      s.owner = p.owner || actorName(e.actor);
      s.driver = s.driver || s.owner;
      s.mode = p.mode || s.mode;
      s.startedAt = e.ts;
      break;

    case 'repo.bound':
      s.git = {
        root: p.root || null,
        branch: p.branch || null,
        worktree: p.worktree || null,
        baseCommit: p.baseCommit || null
      };
      s.repo = p.root ?? s.repo;
      break;

    // Mode lives in the log rather than a settings table because "who put this
    // run on full-access, and when" is an audit question, and it gets asked
    // immediately after anything goes wrong.
    case 'mode.set':
      s.mode = p.mode || s.mode;
      break;

    case 'agent.joined': {
      const name = p.name || actorName(e.actor);
      if (!s.agents.find((a) => a.name === name)) {
        s.agents.push({ name, model: p.model || null, joinedAt: e.ts });
      }
      if (!s.agent) s.agent = name;
      break;
    }

    case 'presence.seen':
      // touchPerson above already recorded it; the event exists so a watcher
      // joining mid-run shows up before they have done anything.
      break;

    case 'plan.set': {
      const incoming = Array.isArray(p.steps) ? p.steps : [];
      // Steps already running or finished keep their state. The agent rewrites
      // its plan constantly and must not be able to erase what it already did.
      const kept = new Map(s.steps.map((x) => [x.id, x]));
      s.steps = incoming.map((raw, i) => {
        const id = raw.id || 'step_' + i;
        const prev = kept.get(id);
        if (prev) return { ...prev, title: raw.title || prev.title };
        return {
          id,
          title: raw.title || '',
          status: raw.status || 'queued',
          ownerKind: raw.ownerKind || 'agent',
          ownerName: raw.ownerName || s.agent,
          startedAt: null,
          endedAt: null,
          summary: null,
          output: []
        };
      });
      break;
    }

    case 'step.added':
      if (!findStep(s, p.id)) {
        s.steps.push({
          id: p.id,
          title: p.title || '',
          status: 'queued',
          ownerKind: p.ownerKind || 'agent',
          ownerName: p.ownerName || s.agent,
          startedAt: null,
          endedAt: null,
          summary: null,
          output: []
        });
      }
      break;

    case 'step.started': {
      const st = findStep(s, p.id);
      if (st) {
        st.status = 'running';
        st.startedAt = e.ts;
      }
      break;
    }

    case 'step.output': {
      const st = findStep(s, p.id);
      if (st) st.output.push({ ts: e.ts, line: p.line || '', stream: p.stream || 'stdout' });
      break;
    }

    case 'step.finished': {
      const st = findStep(s, p.id);
      if (st) {
        st.status = p.failed ? 'failed' : 'done';
        st.endedAt = e.ts;
        st.summary = p.summary ?? st.summary;
      }
      break;
    }

    case 'turn.started':
      s.turns.push({
        id: p.turnId,
        by: actorName(e.actor),
        byKind: actorKind(e.actor),
        text: p.text || '',
        images: p.images || [],
        reasoning: [],
        messages: [],
        usage: null,
        startedAt: e.ts,
        endedAt: null
      });
      break;

    case 'turn.reasoning': {
      const t = s.turns.find((x) => x.id === p.turnId);
      if (t) t.reasoning.push({ ts: e.ts, text: p.text || '' });
      break;
    }

    case 'turn.message': {
      const t = s.turns.find((x) => x.id === p.turnId);
      if (t) t.messages.push({ ts: e.ts, text: p.text || '', by: actorName(e.actor) });
      break;
    }

    case 'turn.finished': {
      const t = s.turns.find((x) => x.id === p.turnId);
      if (t) {
        t.endedAt = e.ts;
        t.usage = p.usage || null;
      }
      break;
    }

    /**
     * A directive is a human steering a run that is already moving. The three
     * events are deliberately separate: sent (the words left the person),
     * applied (the agent merged them into its context, so they COULD take
     * effect) and honored (the agent says it actually acted, and what it did).
     * Collapsing applied and honored would let the record claim obedience it
     * cannot evidence.
     */
    case 'directive.sent':
      s.directives.push({
        id: p.id,
        text: p.text || '',
        by: actorName(e.actor),
        ts: e.ts,
        atStep: p.atStep || null,
        appliedAt: null,
        honoredAt: null,
        honoredNote: null
      });
      break;

    case 'directive.applied': {
      const d = s.directives.find((x) => x.id === p.id);
      if (d) d.appliedAt = e.ts;
      break;
    }

    case 'directive.honored': {
      const d = s.directives.find((x) => x.id === p.id);
      if (d) {
        d.honoredAt = e.ts;
        d.honoredNote = p.note || null;
      }
      break;
    }

    /**
     * A gate is the approval card, but as a session fact rather than a local
     * modal. That is the whole reason this port exists: any authorised watcher
     * can answer it, and the answer is recorded against a person.
     */
    case 'gate.requested':
      s.gates.push({
        id: p.id,
        callId: p.callId || null,
        kind: p.kind || 'command',
        subject: p.subject || '',
        reason: p.reason || null,
        risk: p.risk || 'unknown',
        /**
         * Who may answer. Empty means anyone in the room, which is the right
         * default for a small team - narrowing it is a policy choice, and a
         * gate nobody present is allowed to answer is just a stuck run.
         */
        answerableBy: Array.isArray(p.answerableBy) ? p.answerableBy : [],
        requestedAt: e.ts,
        resolvedAt: null,
        approved: null,
        by: null
      });
      s.status = 'blocked';
      break;

    case 'gate.resolved': {
      const g = s.gates.find((x) => x.id === p.id);
      // Someone not on the list answering is dropped rather than honoured. The
      // reducer is the only place this can be enforced, because a client that
      // wants to bypass it simply would not ask.
      if (g && !g.resolvedAt && canAnswer(g, e.actor)) {
        g.resolvedAt = e.ts;
        g.approved = !!p.approved;
        g.by = actorName(e.actor);
      }
      if (!s.gates.some((x) => !x.resolvedAt) && s.status === 'blocked') s.status = 'running';
      break;
    }

    /**
     * `artifacts` is the append-only history of every touch, because the order
     * changes happened in is itself evidence. `changes` is the reduced view -
     * one entry per path, latest wins - which is what a person actually looks
     * at: the state of the work now, not forty entries for one file.
     */
    case 'artifact.changed': {
      const entry = {
        path: p.path,
        status: p.status || 'modified',
        added: p.added || 0,
        removed: p.removed || 0,
        by: actorName(e.actor),
        ts: e.ts
      };
      s.artifacts.push(entry);
      const i = s.changes.findIndex((c) => c.path === entry.path);
      if (i === -1) s.changes.push({ ...entry });
      else s.changes[i] = { ...entry };
      break;
    }

    case 'command.ran':
      s.commands.push({
        cmd: p.cmd || '',
        exitCode: typeof p.exitCode === 'number' ? p.exitCode : null,
        ms: p.ms || 0,
        by: actorName(e.actor),
        ts: e.ts
      });
      break;

    case 'cost.reported':
      s.costUsd += Number(p.usd) || 0;
      break;

    case 'note.posted':
      s.notes.push({ text: p.text || '', by: actorName(e.actor), ts: e.ts });
      break;

    case 'run.paused':
      s.status = 'paused';
      s.pausedReason = p.reason || null;
      break;

    case 'run.resumed':
      s.status = 'running';
      s.pausedReason = null;
      break;

    case 'run.finished':
      s.status = p.failed ? 'failed' : 'done';
      s.endedAt = e.ts;
      break;

    /**
     * Handing a run to someone else. This is an event and not a field on a
     * settings row because the question people actually ask afterwards is
     * "who had this when it went wrong" - which is a question about a moment,
     * not about the current state.
     *
     * Handing off also moves who gates route to. A run blocked on a person who
     * has gone home is the failure this whole product exists to prevent.
     */
    case 'run.handed_off': {
      const to = p.to || null;
      s.handoffs.push({
        from: actorName(e.actor),
        to,
        note: p.note || null,
        ts: e.ts
      });
      if (to) s.driver = to;
      break;
    }

    /**
     * Claiming a step takes it away from the agent and gives it to a person.
     * The agent must stop working it, which is the point: some steps are not
     * the agent's to do, and "I am handling this one" needs somewhere to live
     * other than a chat message nobody reads in time.
     */
    case 'step.claimed': {
      const st = findStep(s, p.id);
      if (st && st.status !== 'done') {
        st.status = 'claimed';
        st.ownerKind = 'human';
        st.ownerName = actorName(e.actor);
      }
      break;
    }

    case 'step.released': {
      const st = findStep(s, p.id);
      if (st && st.status === 'claimed') {
        st.status = 'queued';
        st.ownerKind = 'agent';
        st.ownerName = s.agent;
      }
      break;
    }

    default:
      break;
  }
  return s;
}

function applyEvents(s, events) {
  for (const e of events) apply(s, e);
  return s;
}

/** The entry point: rebuild a session's state from its whole log. */
function reduce(id, events) {
  return applyEvents(emptyState(id), events);
}

/** Whether this actor is allowed to answer this gate. Empty list means anyone. */
function canAnswer(gate, actor) {
  if (actorKind(actor) !== 'human') return false;
  if (!gate.answerableBy || !gate.answerableBy.length) return true;
  return gate.answerableBy.includes(actorName(actor));
}

/** Gates still waiting on a human. What a watcher gets pinged about. */
function openGates(s) {
  return s.gates.filter((g) => !g.resolvedAt);
}

/**
 * The session as it stood at a given sequence number.
 *
 * This is close to free because the reducer is pure and the log is ordered:
 * scrubbing a run back to any moment is a slice and a replay. It is the same
 * trick as version history in a design tool, and almost nobody building agent
 * tooling has it, because almost nobody keeps an ordered log to replay.
 */
function sessionAt(id, events, seq) {
  return reduce(id, events.filter((e) => e.seq <= seq));
}

/**
 * The events a fork should start from: everything up to the chosen moment.
 *
 * Paired with the worktree-per-thread the app already does, this is "I do not
 * like where this went at step 42, take it from there down a different path"
 * without losing the run you forked away from.
 */
function forkPoint(events, seq) {
  return events.filter((e) => e.seq <= seq).map((e) => ({
    kind: e.kind,
    actor: e.actor,
    payload: e.payload
  }));
}

/** Directives the agent has taken in but not yet confirmed acting on. */
function unhonoredDirectives(s) {
  return s.directives.filter((d) => d.appliedAt && !d.honoredAt);
}

function currentStep(s) {
  return s.steps.find((x) => x.status === 'running') || null;
}

module.exports = {
  EVENT_KINDS,
  emptyState,
  apply,
  applyEvents,
  reduce,
  sessionAt,
  forkPoint,
  openGates,
  canAnswer,
  unhonoredDirectives,
  currentStep,
  actorName,
  actorKind
};
