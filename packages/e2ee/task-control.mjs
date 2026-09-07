// A teammate asking the host to record something in a task's log.
//
// Only the host writes an encrypted task log, which is what makes its ordering and its digest
// chain worth anything: one writer, one sequence, one chain. So a teammate's question does
// not go into the log directly. It is sealed to the host's endpoint, carried by the relay's
// device mailbox as an envelope the relay cannot open, and appended by the host after it has
// checked who sent it and whether they may.
//
// That indirection is what makes the attribution in the log real. `help.requested` states who
// asked, and the host states it from the authenticated sender of the envelope rather than
// from a name the sender typed. A client asserting its own identity here would leave the log
// recording a claim and calling it a fact.
import { routing } from './task-log.mjs';

// What sealControl stamps on the wire, and what this module puts inside it. The same sealed
// channel carries project history handoffs, so a message that is not a task control is not
// an error here - it is somebody else's.
export const ENVELOPE_TYPE = 'plexus.control.v1';
export const CONTROL_TYPE = 'plexus.task.control.v1';
export const HISTORY_TYPE = 'plexus.task.history.v1';
export const ACTIONS = ['help.request', 'help.settle', 'task.outcome', 'responsibility.handover'];

export class TaskControlError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new TaskControlError(code); };

// '@u_x:plexus.local' back to 'u_x'. Anything else is not one of ours.
export const accountOf = (user) => {
  const match = /^@([A-Za-z0-9_-]{1,64}):plexus\.local$/.exec(String(user || ''));
  return match ? match[1] : null;
};

/**
 * Ask the host to record something.
 *
 * `writer` is the host endpoint this client has confirmed. `sealControl` refuses outright to
 * seal for a device this endpoint has not confirmed, so an unconfirmed host cannot be sent
 * anything at all - the same gate the catch-up screen puts in front of reading.
 */
export async function sendTaskControl(endpoint, writer, { task, action, payload }) {
  if (!ACTIONS.includes(action)) fail('unsupported_task_control');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_task_control');
  const envelope = await endpoint.sealControl(writer.user, writer.device, {
    type: CONTROL_TYPE, task: routing(task), action, payload
  });
  await endpoint.transport.deliverToDevice(writer.user, writer.device, envelope);
  return { delivered: true };
}

/**
 * The host's side: is this decrypted to-device event a control message for this task?
 *
 * Returns null for anything that is not one, because the same mailbox carries room keys and
 * a host draining it must not treat "not for me" as an error. Everything about the sender
 * comes from the seal: an unverified or undecrypted envelope is refused outright, and the
 * message must name the task it claims to be about rather than inheriting one from the
 * mailbox it arrived in.
 */
/**
 * The other direction: the host handing a newly granted teammate the history of a task.
 *
 * #8 built the handoff itself - an authenticated export the writer alone may produce - and
 * left it with no way to travel. This carries it on the same sealed channel, so the blob and
 * the transfer key that opens it arrive together and only for the device they were meant for.
 * The verification stays exactly where #8 put it: acceptProjectAccess checks the seal came
 * from the writer, and this adds nothing to that.
 */
export function readTaskHistory(event, task) {
  if (!event || event.type !== ENVELOPE_TYPE) return null;
  if (!event.decrypted || !event.verified || !event.senderDevice) fail('task_control_unauthenticated');
  const content = event.content;
  if (!content || content.type !== HISTORY_TYPE) return null;
  const named = content.task || {};
  const expected = routing(task);
  if (Object.keys(expected).some((key) => named[key] !== expected[key])) return null;
  if (!content.history || typeof content.history.blob !== 'string' || !content.history.envelope) fail('invalid_task_control');
  return { sender: accountOf(event.sender), senderDevice: event.senderDevice, history: content.history };
}

export function readTaskControl(event, task) {
  if (!event || event.type !== ENVELOPE_TYPE) return null;
  if (!event.decrypted || !event.verified || !event.senderDevice) fail('task_control_unauthenticated');
  const content = event.content;
  if (!content || content.type !== CONTROL_TYPE) return null;
  if (!ACTIONS.includes(content.action) ||
      !content.payload || typeof content.payload !== 'object' || Array.isArray(content.payload)) {
    fail('invalid_task_control');
  }
  const named = content.task || {};
  const expected = routing(task);
  if (Object.keys(expected).some((key) => named[key] !== expected[key])) return null;
  const sender = accountOf(event.sender);
  if (!sender) fail('task_control_unauthenticated');
  return { sender, senderDevice: event.senderDevice, action: content.action, payload: content.payload };
}
