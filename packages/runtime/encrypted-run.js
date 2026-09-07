'use strict';
// Running a real provider task and writing it to the encrypted log.
//
// #6 built the log and drove it with fixture events. #7 needs the same log written by an
// actual turn, and the shape of the two vocabularies makes that mostly a translation rather
// than a new execution engine: a turn already emits plan updates, tool completions, file
// changes and messages, and the encrypted log already has an event for each.
//
// Two rules govern the translation:
//
//   * Only completed facts cross. A turn streams deltas - half a sentence, a partial command
//     output - and an append-only encrypted log is the wrong place for them: every delta
//     would be a permanent record of something that was not true yet.
//   * Nothing is invented. An event with no encrypted counterpart is dropped rather than
//     approximated, and the dropped kinds are named here so the omission is deliberate
//     rather than discovered later by someone reading a gap in a task history.
const { Events, ItemTypes, TurnStatus } = require('../protocol');

// Turn events that deliberately do not reach the log, and why.
const NOT_TRANSLATED = {
  [Events.TURN_STARTED]: 'the log records what happened, and a turn beginning is not yet anything',
  [Events.ITEM_STARTED]: 'an item that has started has not done anything yet',
  [Events.AGENT_MESSAGE_DELTA]: 'a fragment of a sentence is not a message',
  [Events.REASONING_DELTA]: 'reasoning is not recorded in the task log at all',
  [Events.COMMAND_OUTPUT_DELTA]: 'partial output is not a result'
};

// One turn event to one encrypted event, or null. `seen` carries ids already written so a
// replayed item cannot append twice.
function translate(event) {
  const method = event.method;
  if (method === Events.TURN_PLAN_UPDATED) {
    const steps = (event.plan || []).map((entry) => ({
      text: entry.step ?? entry.text ?? '',
      status: entry.status === 'inProgress' ? 'in-progress' : (entry.status || 'pending')
    }));
    return { type: 'plan.updated', payload: { steps } };
  }
  if (method === Events.TURN_COMPLETED) {
    const outcome = event.status === TurnStatus.COMPLETED ? 'completed'
      : event.status === 'interrupted' ? 'cancelled' : 'failed';
    return { type: 'task.completed', payload: { outcome } };
  }
  if (method !== Events.ITEM_COMPLETED || !event.item) return null;
  const item = event.item;
  if (item.type === ItemTypes.USER_MESSAGE || item.type === ItemTypes.AGENT_MESSAGE) {
    return { type: 'message.added', payload: { id: item.id, text: item.text || '' } };
  }
  if (item.type === ItemTypes.COMMAND_EXECUTION) {
    return { type: 'tool.completed', payload: {
      id: item.id,
      name: item.executor === 'workspace' ? 'workspace.command' : 'shell.command',
      // The command and its output are content: they name files and carry results, and this
      // is the log where content is supposed to be encrypted.
      arguments: { command: item.command, cwd: item.cwd || null },
      result: { exitCode: item.exitCode ?? null, output: item.aggregatedOutput || '', status: item.status }
    } };
  }
  if (item.type === ItemTypes.FILE_CHANGE) {
    const files = (item.changes || []).map((change) => ({
      path: change.path,
      patch: change.kind + (typeof change.additions === 'number' ? ' +' + change.additions : '') +
        (typeof change.deletions === 'number' ? ' -' + change.deletions : '')
    }));
    return { type: 'diff.updated', payload: { files } };
  }
  return null;
}

// The two halves of an approval, and both belong in the history.
//
// The request half is what makes #9's catch-up view able to say a task is stopped waiting
// for somebody rather than merely that nothing has happened lately - and it has to carry the
// action, because an approval prompt with the action hidden is how people authorise things
// they did not read. The answering half is a recorded decision: someone took responsibility
// for what a machine was about to do, which is the one control event that is also history.
//
// They are paired by request id, so an approval nobody answered stays visibly outstanding.
function translateApproval(event, actorName) {
  if (event.method === Events.COMMAND_REQUEST_APPROVAL || event.method === Events.FILECHANGE_REQUEST_APPROVAL) {
    const action = event.method === Events.COMMAND_REQUEST_APPROVAL
      ? 'Run: ' + event.command
      : 'Write ' + (event.changes || []).map((change) => change.path).join(', ');
    return { type: 'approval.requested', payload: {
      id: event.requestId,
      action,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(Number.isSafeInteger(event.expiresAt) ? { expiresAt: event.expiresAt } : {})
    } };
  }
  if (event.method !== Events.SERVER_REQUEST_RESOLVED) return null;
  return { type: 'decision.recorded', payload: {
    actor: actorName || (event.by && event.by.name) || 'unknown',
    text: 'Approval ' + event.decision,
    basis: event.requestId
  } };
}

// Deterministic ids, so a retried append is recognised as the same event rather than
// appended twice. #6's writer refuses a reused id whose content differs, which makes this
// the join between "the turn produced this again" and "this is genuinely new".
const eventId = (taskId, seq) => 'ev_' + require('crypto').createHash('sha256')
  .update(taskId + ':run:' + seq).digest('hex').slice(0, 32);

/**
 * Drives one encrypted task to completion with a real provider turn.
 *
 * `opened` is what EncryptedFixtureHost.open() returns - a reader, a writer bound to the
 * task, and the decrypted objective. `runTurn` is given an emit function and returns when
 * the turn is done; the runtime supplies one that builds a TurnSession.
 */
class EncryptedTaskRun {
  constructor({ opened, task, runTurn, provider = null, log = () => {} }) {
    this.opened = opened;
    this.task = task;
    this.runTurn = runTurn;
    // Which provider this host is about to run. Asserted here rather than taken from the
    // creating request, because a creator naming a provider is a preference and a host
    // naming one is a fact - and "which provider touched my code" is a question a teammate
    // reading this task later actually has.
    this.provider = provider;
    this.log = log;
    this.written = 0;
    this.dropped = new Map();
  }

  // Appends are serialized through the writer's own queue, so the log keeps the order the
  // turn produced rather than whichever encryption finished first.
  async append(entry) {
    const seq = ++this.written;
    await this.opened.writer.append(entry, eventId(this.task.id, seq));
  }

  async start() {
    const objective = this.opened.objective;
    // The creating request is the first event, so a reader starting from zero learns what
    // was asked before it learns what was done about it.
    if (this.opened.reader.seq === 0) {
      await this.append({ type: 'task.created', payload: {
        title: objective.title, objective: objective.objective,
        ...(this.provider ? { provider: this.provider } : {})
      } });
    }
    const queue = [];
    let pump = Promise.resolve();
    const emit = (event) => {
      const entry = translate(event) || translateApproval(event);
      if (!entry) {
        const why = NOT_TRANSLATED[event.method];
        if (why) this.dropped.set(event.method, why);
        return;
      }
      queue.push(entry);
      pump = pump.then(() => this.append(queue.shift())).catch((error) => {
        // A failed append must stop the task rather than leave a hole in the history.
        this.log('encrypted append failed: ' + (error.code || error.message));
        throw error;
      });
    };
    await this.runTurn(emit, objective);
    await pump;
    return { events: this.written, dropped: [...this.dropped.keys()] };
  }
}

module.exports = { EncryptedTaskRun, translate, translateApproval, NOT_TRANSLATED, eventId };
