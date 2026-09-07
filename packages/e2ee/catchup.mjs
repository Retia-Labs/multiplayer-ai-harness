// What a teammate needs to know about a task they have never read, and where each claim
// came from.
//
// Three rules shape everything here:
//
//   1. Every line carries its source. A projection with no way back to the record it came
//      from is a rumour, and this screen exists to stop people acting on rumours.
//   2. Recorded and derived are never blurred. "Maya decided to reuse the key" and "the log
//      suggests the key was reused" are different claims, and only one of them may be
//      attributed to a person. Nothing here invents a human decision or an approval.
//   3. It is a pure function of accepted events. The same events produce the same catch-up
//      whether they were watched as they happened or replayed hours later from sequence
//      zero - which is the whole promise being made to someone joining late.
//
// It runs on an endpoint that has already decrypted the log. Nothing about it belongs on a
// relay, and nothing here should ever be given a reason to.

export const CATCHUP_VERSION = 1;

const ref = (event, index) => ({ seq: index + 1, type: event.type });

// A claim the log states outright, tied to the event that states it.
const recorded = (value, event, index, extra = {}) =>
  ({ value, provenance: 'recorded', source: ref(event, index), ...extra });

// A claim this code worked out. True or not, nobody said it.
const derived = (value, sources, extra = {}) =>
  ({ value, provenance: 'derived', sources, ...extra });

const unavailable = (why) => ({ value: null, provenance: 'unavailable', reason: why });

function lastIndexOf(events, type) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return i;
  return -1;
}

// Freshness is about what this endpoint can honestly claim, not about elapsed time alone.
//
// `caught-up` means "through the head the relay advertised", which is not the same as "up to
// date with the host" - a host that stopped talking to the relay leaves both of them looking
// identical. So a disconnected host is reported as unknown rather than current, however
// recently the last event arrived.
function freshness({ status, seq, head, hostConnected, lastEventAt, now, staleAfterMs, events }) {
  const age = typeof lastEventAt === 'number' && typeof now === 'number' ? now - lastEventAt : null;
  if (status?.state === 'error') {
    return { state: 'error', code: status.code || 'unknown_error', through: seq, age,
      explain: 'The last attempt to catch up failed. What is shown is the history accepted before that.' };
  }
  // Nothing accepted yet is not the same as nothing happening. An endpoint that has read no
  // events cannot claim currency, whatever the clock says.
  if (!events) {
    return { state: 'unknown', through: seq, age: null,
      explain: 'No events from this task have been accepted on this endpoint yet.' };
  }
  if (hostConnected === false) {
    return { state: 'unknown', through: seq, age,
      explain: 'The execution host is not connected, so nothing here can be confirmed as current.' };
  }
  if (status?.state === 'replaying') {
    return { state: 'replaying', through: seq, age, explain: 'Still reading the log.' };
  }
  if (typeof head === 'number' && head > seq) {
    return { state: 'behind', through: seq, head, age,
      explain: 'The relay advertises events this endpoint has not accepted yet.' };
  }
  if (age !== null && typeof staleAfterMs === 'number' && age > staleAfterMs) {
    return { state: 'stale', through: seq, age,
      explain: 'Nothing has happened for a while. The host is connected, so this is quiet rather than lost.' };
  }
  return { state: 'current', through: seq, age, explain: 'Read through the latest event this endpoint has accepted.' };
}

/**
 * Build the catch-up projection from an accepted task snapshot.
 *
 * `snapshot` is what EncryptedTaskReader.snapshot() returns - reduced state plus the
 * sequence and status it was reduced at. `context` carries the facts the log itself does
 * not contain: who is responsible, which host and provider are executing, and whether that
 * host is currently reachable. Those are passed in rather than guessed, because a projection
 * that invents an execution host is worse than one that says it does not know.
 */
export function catchUp(snapshot, context = {}) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const {
    responsible = null, host = null, provider = null, hostConnected = null,
    head = null, now = null, staleAfterMs = 10 * 60 * 1000, taskId = null, projectId = null
  } = context;

  const createdIndex = events.findIndex((e) => e.type === 'task.created');
  const created = createdIndex >= 0 ? events[createdIndex] : null;
  const planIndex = lastIndexOf(events, 'plan.updated');
  const completedIndex = lastIndexOf(events, 'task.completed');
  const diffIndex = lastIndexOf(events, 'diff.updated');

  // The objective is quoted from the creating event, never summarised into something the
  // requester did not write.
  const objective = created
    ? recorded(created.payload.objective, created, createdIndex, { title: created.payload.title })
    : unavailable('This log has no creation event, so the objective is unknown.');

  // Decisions are only decisions when the log says somebody decided. Everything else in a
  // conversation is a message, however decisive it sounds.
  const decisions = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'decision.recorded')
    .map(({ event, index }) => recorded(event.payload.text, event, index, {
      actor: event.payload.actor,
      basis: event.payload.basis || null
    }));

  const plan = planIndex >= 0
    ? recorded(events[planIndex].payload.steps.map((step) => ({ text: step.text, status: step.status })), events[planIndex], planIndex)
    : unavailable('No plan has been recorded for this task.');

  // The current step is this code reading a plan, not the agent announcing one.
  const currentStep = planIndex >= 0
    ? derived(events[planIndex].payload.steps.find((step) => step.status !== 'completed')?.text ?? null,
      [ref(events[planIndex], planIndex)])
    : unavailable('No plan has been recorded for this task.');

  const changes = diffIndex >= 0
    ? recorded(events[diffIndex].payload.files.map((file) => ({ path: file.path })), events[diffIndex], diffIndex)
    : unavailable('No file changes have been recorded for this task.');

  const activity = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'activity.recorded')
    .map(({ event, index }) => recorded(event.payload.description, event, index, { paths: event.payload.paths }));

  const outcome = completedIndex >= 0
    ? recorded(events[completedIndex].payload.outcome, events[completedIndex], completedIndex)
    : derived('in-progress', events.length ? [ref(events[events.length - 1], events.length - 1)] : []);

  // Pending work is only ever what the log records as pending, never a message that happens
  // to end in a question mark.
  //
  // An approval is answered by a decision.recorded whose `basis` is its id - the same event
  // that records who took responsibility - so pairing them needs no second event type and
  // no clock. An approval nobody answered stays outstanding, including one that expired:
  // "this expired unanswered" is a true statement about the log, whereas clearing it here
  // would be this code deciding a request went away because time passed.
  const answered = new Set(events
    .filter((event) => event.type === 'decision.recorded' && typeof event.payload.basis === 'string')
    .map((event) => event.payload.basis));
  const approvals = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'approval.requested' && !answered.has(event.payload.id))
    .map(({ event, index }) => recorded({
      id: event.payload.id,
      action: event.payload.action,
      reason: event.payload.reason ?? null,
      expiresAt: event.payload.expiresAt ?? null,
      expired: typeof event.payload.expiresAt === 'number' ? event.payload.expiresAt < now : null
    }, event, index));

  // What the task is actually stopped on. An outstanding approval outranks a plan step,
  // because a step in progress is work continuing and an unanswered approval is work that
  // cannot continue. Both are derived: the log records a request, not a state of being
  // blocked, and saying otherwise would put words in the writer's mouth.
  const blocker = approvals.length
    ? derived('Waiting for a decision on: ' + approvals[0].value.action, approvals.map((entry) => entry.source))
    : outcome.value === 'in-progress' && currentStep.value
      ? derived(currentStep.value, currentStep.sources || [])
      : unavailable('Nothing in the log identifies a blocker.');

  const pending = { approvals, blocker };

  const lastEventAt = typeof context.lastEventAt === 'number' ? context.lastEventAt : null;

  return {
    version: CATCHUP_VERSION,
    scope: {
      taskId, projectId,
      title: created ? created.payload.title : null,
      from: events.length ? 1 : 0,
      through: snapshot?.seq ?? 0,
      events: events.length
    },
    freshness: freshness({ status: snapshot?.status, seq: snapshot?.seq ?? 0, head, hostConnected, lastEventAt, now, staleAfterMs, events: events.length }),
    // Operational facts the log does not carry. Absent means absent, and says so.
    responsible: responsible ? { value: responsible, provenance: 'context' } : unavailable('No responsible teammate is recorded for this task.'),
    host: host ? { value: host, provenance: 'context' } : unavailable('No execution host is recorded for this task.'),
    // The log carries the provider when the host asserted one, and that beats anything a
    // caller passes in: a recorded fact and a screen's own guess are not interchangeable.
    provider: created && typeof created.payload.provider === 'string'
      ? recorded(created.payload.provider, created, createdIndex)
      : provider ? { value: provider, provenance: 'context' }
        : unavailable('No provider is recorded for this task.'),
    hostConnected,
    objective,
    decisions,
    plan,
    currentStep,
    changes,
    activity,
    outcome,
    pending
  };
}

// Every source reference a projection makes, so a renderer can prove each one resolves to an
// event this endpoint actually accepted - and show the ones that do not as unavailable
// rather than as a dead link.
export function sourcesOf(projection) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.source) out.push(node.source);
    if (Array.isArray(node.sources)) out.push(...node.sources);
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
  };
  visit(projection);
  return out;
}

// Resolve one source reference against the accepted events. A reference that does not
// resolve is reported, never silently dropped: "the record is missing" is information.
export function openSource(snapshot, source) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const event = events[source?.seq - 1];
  if (!event || event.type !== source.type) return { available: false, reason: 'source_unavailable', source };
  return { available: true, source, event };
}
