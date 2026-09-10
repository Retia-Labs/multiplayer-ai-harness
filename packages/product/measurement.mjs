import { digest, exact, TASK_ID } from '../protocol/encrypted-task.mjs';
export const MEASUREMENT_DAYS = 30;
export const DEDUP_DAYS = 365;
export const MEASUREMENT_NOTICE = 'Optional measurement records setup outcomes, successful solo tasks, invitations, catch-up and help, authenticated controls, confirmed delivery, task outcomes and later-week active team returns. It uses pseudonymous person/team IDs, opaque task IDs and fixed event names, never task content. Events expire after 30 days; content-free retry IDs expire after 365 days. Turning measurement off deletes both. Views, invitations, help and queued input do not activate a person.';
export const KINDS = ['setup', 'invite', 'catchup', 'help', 'solo', 'control', 'delivered', 'approval', 'completion', 'activation', 'active'];
export const pseudonym = (type, id) => digest({ type: 'plexus.measurement.' + type + '.v1', id });
export async function measurementEvent({ kind, userId, teamId, taskId = null, source, at = Date.now(), stage = null, outcome = null }) {
  return { version: 1, id: await digest({ kind, userId, teamId, taskId, source }), kind,
    person: await pseudonym('person', userId), team: await pseudonym('team', teamId),
    task: taskId, at, stage, outcome };
}
export function validMeasurement(event, now = Date.now()) {
  return exact(event, ['version', 'id', 'kind', 'person', 'team', 'task', 'at', 'stage', 'outcome']) && event.version === 1 &&
    ['id', 'person', 'team'].every(key => typeof event[key] === 'string' && /^[a-f0-9]{64}$/.test(event[key])) && KINDS.includes(event.kind) &&
    (event.task === null || typeof event.task === 'string' && TASK_ID.test(event.task)) && Number.isSafeInteger(event.at) &&
    event.at > now - MEASUREMENT_DAYS * 86400000 && event.at <= now + 60000 &&
    (event.stage === null || ['account', 'endpoint', 'project', 'provider', 'solo', 'invite', 'recovery'].includes(event.stage)) &&
    (event.outcome === null || ['ready', 'pending', 'failed', 'unavailable', 'completed', 'cancelled'].includes(event.outcome));
}
// Input must be an authenticated EncryptedTaskReader snapshot. Only fixed fields
// leave this endpoint; this function never serializes an event payload.
export function observedOutcomes(snapshot, { userId, creatorUserId }) {
  const events = snapshot?.events || [], participants = new Set(), outcomes = [];
  const receipts = new Map(), turns = new Map();
  let deliveredByPeer = false, firstStart = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index], p = event.payload || {}, source = index + 1;
    const emit = (kind, actor, outcome = null) => { if (actor === userId) outcomes.push({ kind, source, at: p.occurredAt, outcome }); };
    if (event.type === 'turn.started') {
      turns.set(p.turnId, { actor: p.actor, source });
      participants.add(p.actor); emit('active', p.actor);
      if (!firstStart) firstStart = { ...p, source };
      else emit('control', p.actor);
    }
    if (event.type === 'turn.completed' && p.status === 'completed') {
      const turn = turns.get(p.turnId);
      if (turn?.actor === userId && turn.actor === creatorUserId && participants.size === 1 && !outcomes.some(outcome => outcome.kind === 'solo')) {
        outcomes.push({ kind: 'solo', source: 'first-successful-turn', at: p.occurredAt });
      }
      // A host-side start can fail before provider delivery. A completed peer turn
      // establishes delivery; queued or failed starts cannot qualify the task.
      if (turn && turn.actor !== creatorUserId) { deliveredByPeer = true; emit('delivered', turn.actor); }
    }
    if (event.type === 'command.receipt') receipts.set(p.commandId, { ...p, source });
    if (event.type === 'decision.recorded' && p.basis && ['accept', 'decline', 'reject'].includes(p.decision)) {
      participants.add(p.actor); emit('approval', p.actor); emit('active', p.actor);
      if (p.actor !== creatorUserId) deliveredByPeer = true;
    }
    if (event.type === 'help.requested') emit('help', p.from);
    if (event.type === 'task.completed') { emit('completion', p.by, p.outcome); emit('active', p.by); }
  }
  for (const p of receipts.values()) {
    // action is recorded by the host, so a help/diff/handoff receipt cannot be
    // mistaken for a direction delivered to the agent.
    if (!['turn.start', 'turn.steer', 'turn.interrupt', 'approval.resolve'].includes(p.action)) continue;
    if (['accepted', 'queued', 'delivered'].includes(p.state)) {
      participants.add(p.actor);
      if (p.actor === userId) outcomes.push({ kind: 'control', source: 'command:' + p.commandId, at: p.occurredAt }, { kind: 'active', source: 'command:' + p.commandId, at: p.occurredAt });
    }
    if (p.state === 'delivered' && ['turn.start', 'turn.steer', 'approval.resolve'].includes(p.action)) {
      if (p.actor !== creatorUserId) deliveredByPeer = true;
      if (p.actor === userId) outcomes.push({ kind: 'delivered', source: 'command:' + p.commandId, at: p.occurredAt });
    }
  }
  if (participants.size >= 2 && participants.has(userId) && deliveredByPeer) {
    outcomes.push({ kind: 'activation', source: 'qualified', at: events.at(-1)?.payload?.occurredAt });
  }
  return outcomes;
}
