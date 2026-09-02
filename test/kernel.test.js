/**
 * Tests for the event log and the reducer.
 *
 * These two files are the foundation the multiplayer story rests on, so the
 * properties worth asserting are the ones that break silently: chain integrity
 * under tampering, idempotent replay after a timeout, and a reducer that gives
 * the same answer on every machine.
 *
 * Run with: npm run test:kernel
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EventLog, digest } = require('../src/main/log');
const { reduce, sessionAt, forkPoint, openGates, unhonoredDirectives, currentStep } = require('../src/main/kernel');

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-log-'));
  return new EventLog(dir);
}

const S = 'sess_test';

/* ------------------------------------------------------------------ *
 * Event log
 * ------------------------------------------------------------------ */

test('append assigns contiguous sequence numbers and chains hashes', () => {
  const log = tmpLog();
  log.append(S, { kind: 'session.started', actor: 'human:priya', payload: { title: 'x' } });
  log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { text: 'hello' } });
  const events = log.read(S);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[0].prevHash, '');
  assert.equal(events[1].prevHash, events[0].hash);
  assert.equal(log.verify(S).ok, true);
});

test('a batch append chains within itself', () => {
  const log = tmpLog();
  log.append(S, [
    { kind: 'step.added', actor: 'agent:quorum', payload: { id: 'a' } },
    { kind: 'step.added', actor: 'agent:quorum', payload: { id: 'b' } },
    { kind: 'step.added', actor: 'agent:quorum', payload: { id: 'c' } }
  ]);
  const events = log.read(S);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(events[2].prevHash, events[1].hash);
  assert.equal(log.verify(S).ok, true);
});

test('clientId makes a resent append idempotent', () => {
  const log = tmpLog();
  const ev = { kind: 'note.posted', actor: 'human:priya', clientId: 'c1', payload: { text: 'hi' } };
  const first = log.append(S, ev);
  const second = log.append(S, ev); // the reconnect that resends after a timeout

  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'resend must not append a second copy');
  assert.equal(log.read(S).length, 1);
  assert.equal(log.verify(S).ok, true);
});

test('idempotency survives a reload from disk', () => {
  const log = tmpLog();
  log.append(S, { kind: 'note.posted', actor: 'human:priya', clientId: 'c1', payload: {} });

  const reopened = new EventLog(log.dir); // cold start, no cache
  const again = reopened.append(S, {
    kind: 'note.posted',
    actor: 'human:priya',
    clientId: 'c1',
    payload: {}
  });
  assert.equal(again.length, 0);
  assert.equal(reopened.read(S).length, 1);
});

test('verify catches an edited payload', () => {
  const log = tmpLog();
  log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { text: 'original' } });
  log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { text: 'after' } });

  // Tamper on disk, the way someone with filesystem access would.
  const file = path.join(log.dir, S + '.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const row = JSON.parse(lines[0]);
  row.payload = { text: 'forged' };
  lines[0] = JSON.stringify(row);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const fresh = new EventLog(log.dir);
  const result = fresh.verify(S);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'payload altered');
  assert.equal(result.seq, 1);
});

test('verify catches a removed event', () => {
  const log = tmpLog();
  for (let i = 0; i < 3; i++) {
    log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { i } });
  }
  const file = path.join(log.dir, S + '.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n'); // drop the middle

  const fresh = new EventLog(log.dir);
  assert.equal(fresh.verify(S).ok, false);
});

test('a torn final line is discarded, earlier events survive', () => {
  const log = tmpLog();
  log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { text: 'good' } });
  fs.appendFileSync(path.join(log.dir, S + '.jsonl'), '{"kind":"note.pos');

  const fresh = new EventLog(log.dir);
  assert.equal(fresh.read(S).length, 1);
  assert.equal(fresh.verify(S).ok, true);
});

test('redaction removes text without breaking the chain', () => {
  const log = tmpLog();
  log.append(S, { kind: 'step.output', actor: 'agent:quorum', payload: { line: 'AWS_KEY=hunter2' } });
  log.append(S, { kind: 'note.posted', actor: 'human:priya', payload: { text: 'after' } });

  const fresh = new EventLog(log.dir);
  fresh.redact(S, 1, 'human:priya', 'leaked credential');

  const reloaded = new EventLog(log.dir);
  const events = reloaded.read(S);
  assert.deepEqual(events[0].payload, {});
  assert.equal(events[0].redactedBy, 'human:priya');
  assert.equal(events[0].redactedReason, 'leaked credential');
  // The digest of the original still stands, so the chain is intact.
  assert.notEqual(events[0].payloadHash, digest('{}'));
  assert.equal(reloaded.verify(S).ok, true);
});

test('adopt merges remote events in sequence order without renumbering', () => {
  const log = tmpLog();
  const remote = [
    { id: 'r2', sessionId: S, seq: 2, kind: 'note.posted', actor: 'human:sam', ts: 't', payload: {}, payloadHash: 'h', prevHash: '', hash: 'h2' },
    { id: 'r1', sessionId: S, seq: 1, kind: 'note.posted', actor: 'human:sam', ts: 't', payload: {}, payloadHash: 'h', prevHash: '', hash: 'h1' }
  ];
  const fresh = log.adopt(S, remote);
  assert.equal(fresh.length, 2);
  assert.deepEqual(log.read(S).map((e) => e.seq), [1, 2]);

  const again = log.adopt(S, remote); // re-delivery from the stream
  assert.equal(again.length, 0);
});

/* ------------------------------------------------------------------ *
 * Kernel
 * ------------------------------------------------------------------ */

let seq = 0;
function ev(kind, actor, payload) {
  seq += 1;
  return { seq, kind, actor, ts: '2026-09-02T00:00:0' + (seq % 10) + 'Z', payload };
}

test('reduce is deterministic and derives session identity', () => {
  seq = 0;
  const events = [
    ev('session.started', 'human:priya', { title: 'Fix auth', goal: 'g', agent: 'quorum', mode: 'agent' }),
    ev('agent.joined', 'agent:quorum', { name: 'quorum', model: 'gpt-5.1' }),
    ev('repo.bound', 'agent:quorum', { root: '/repo', branch: 'quorum/fix-auth' })
  ];
  const a = reduce('s1', events);
  const b = reduce('s1', events);

  assert.equal(a.title, 'Fix auth');
  assert.equal(a.agent, 'quorum');
  assert.equal(a.git.branch, 'quorum/fix-auth');
  assert.equal(a.people[0].name, 'priya');
  assert.deepEqual(a, b, 'same events must reduce to the same state');
});

test('plan.set preserves progress on steps that already ran', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'read' }, { id: 's2', title: 'edit' }] }),
    ev('step.started', 'agent:quorum', { id: 's1' }),
    ev('step.finished', 'agent:quorum', { id: 's1', summary: 'done reading' }),
    // The agent rewrites its plan and renames the first step.
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'read files' }, { id: 's2', title: 'edit' }, { id: 's3', title: 'test' }] })
  ]);

  assert.equal(s.steps.length, 3);
  assert.equal(s.steps[0].status, 'done', 'a replanned step must not lose its history');
  assert.equal(s.steps[0].summary, 'done reading');
  assert.equal(s.steps[0].title, 'read files', 'but it does take the new title');
});

test('a gate blocks the run and any human can resolve it', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('session.started', 'human:priya', { title: 't' }),
    ev('gate.requested', 'agent:quorum', { id: 'g1', kind: 'command', subject: 'rm -rf build', risk: 'high' }),
    ev('gate.resolved', 'human:sam', { id: 'g1', approved: true })
  ]);

  assert.equal(s.gates[0].approved, true);
  assert.equal(s.gates[0].by, 'sam', 'the answer is recorded against a person');
  assert.equal(s.status, 'running', 'resolving the last open gate unblocks the run');
  assert.equal(openGates(s).length, 0);
});

test('an unresolved gate leaves the run blocked', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('gate.requested', 'agent:quorum', { id: 'g1', subject: 'curl example.com' }),
    ev('gate.requested', 'agent:quorum', { id: 'g2', subject: 'rm x' }),
    ev('gate.resolved', 'human:sam', { id: 'g1', approved: false })
  ]);
  assert.equal(s.status, 'blocked');
  assert.equal(openGates(s).length, 1);
  assert.equal(s.gates[0].approved, false);
});

test('a gate cannot be resolved twice', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('gate.requested', 'agent:quorum', { id: 'g1', subject: 'x' }),
    ev('gate.resolved', 'human:sam', { id: 'g1', approved: true }),
    ev('gate.resolved', 'human:mallory', { id: 'g1', approved: false })
  ]);
  assert.equal(s.gates[0].approved, true);
  assert.equal(s.gates[0].by, 'sam', 'first answer wins');
});

test('directives track sent, applied and honored separately', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('directive.sent', 'human:priya', { id: 'd1', text: 'use fetch, not axios' }),
    ev('directive.applied', 'agent:quorum', { id: 'd1' })
  ]);
  assert.equal(s.directives[0].by, 'priya');
  assert.ok(s.directives[0].appliedAt);
  assert.equal(s.directives[0].honoredAt, null);
  assert.equal(unhonoredDirectives(s).length, 1, 'applied is not proof of obedience');

  const after = reduce('s1', [
    ev('directive.sent', 'human:priya', { id: 'd1', text: 'x' }),
    ev('directive.applied', 'agent:quorum', { id: 'd1' }),
    ev('directive.honored', 'agent:quorum', { id: 'd1', note: 'swapped in api.js' })
  ]);
  assert.equal(after.directives[0].honoredNote, 'swapped in api.js');
  assert.equal(unhonoredDirectives(after).length, 0);
});

test('changes collapse to one entry per path while artifacts keep the history', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('artifact.changed', 'agent:quorum', { path: 'a.js', status: 'modified', added: 3, removed: 1 }),
    ev('artifact.changed', 'agent:quorum', { path: 'b.js', status: 'added', added: 10, removed: 0 }),
    ev('artifact.changed', 'agent:quorum', { path: 'a.js', status: 'modified', added: 7, removed: 2 })
  ]);
  assert.equal(s.artifacts.length, 3, 'the order of touches is evidence, keep it all');
  assert.equal(s.changes.length, 2, 'but a person sees one row per file');
  assert.equal(s.changes.find((c) => c.path === 'a.js').added, 7, 'latest wins');
});

test('turns accumulate reasoning and messages, and report usage', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('turn.started', 'human:priya', { turnId: 't1', text: 'fix the bug' }),
    ev('turn.reasoning', 'agent:quorum', { turnId: 't1', text: 'looking at auth.js' }),
    ev('turn.message', 'agent:quorum', { turnId: 't1', text: 'Found it.' }),
    ev('turn.finished', 'agent:quorum', { turnId: 't1', usage: { input: 100, output: 20 } })
  ]);
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].by, 'priya');
  assert.equal(s.turns[0].reasoning.length, 1);
  assert.equal(s.turns[0].messages[0].text, 'Found it.');
  assert.equal(s.turns[0].usage.input, 100);
});

test('run lifecycle and cost accumulate', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('cost.reported', 'agent:quorum', { usd: 0.02 }),
    ev('run.paused', 'human:priya', { reason: 'lunch' }),
    ev('cost.reported', 'agent:quorum', { usd: 0.03 }),
    ev('run.resumed', 'human:priya', {}),
    ev('run.finished', 'agent:quorum', {})
  ]);
  assert.ok(Math.abs(s.costUsd - 0.05) < 1e-9);
  assert.equal(s.status, 'done');
  assert.equal(s.pausedReason, null);
});

test('unknown event kinds are ignored, not fatal', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('session.started', 'human:priya', { title: 't' }),
    ev('something.from.the.future', 'agent:quorum', { x: 1 }),
    ev('note.posted', 'human:priya', { text: 'still here' })
  ]);
  assert.equal(s.notes.length, 1, 'an old client must survive a newer log');
  assert.equal(s.lastSeq, 3);
});

test('replaying a live log end to end reproduces the same state', () => {
  const log = tmpLog();
  log.append(S, [
    { kind: 'session.started', actor: 'human:priya', payload: { title: 'Fix auth', agent: 'quorum' } },
    { kind: 'plan.set', actor: 'agent:quorum', payload: { steps: [{ id: 's1', title: 'read' }] } },
    { kind: 'step.started', actor: 'agent:quorum', payload: { id: 's1' } },
    { kind: 'gate.requested', actor: 'agent:quorum', payload: { id: 'g1', subject: 'npm test' } },
    { kind: 'gate.resolved', actor: 'human:sam', payload: { id: 'g1', approved: true } },
    { kind: 'step.finished', actor: 'agent:quorum', payload: { id: 's1' } }
  ]);

  const fromMemory = reduce(S, log.read(S));
  const fromDisk = reduce(S, new EventLog(log.dir).read(S));

  assert.deepEqual(fromMemory, fromDisk, 'a watcher reloading must see what the agent sees');
  assert.equal(fromMemory.status, 'running');
  assert.equal(currentStep(fromMemory), null);
  assert.equal(fromMemory.steps[0].status, 'done');
  assert.equal(fromMemory.people.map((p) => p.name).sort().join(','), 'priya,sam');
});

/* ------------------------------------------------------------------ *
 * Handoff, claim-to-steer, gate routing, time travel
 * ------------------------------------------------------------------ */

test('the session opens with the owner holding the wheel', () => {
  seq = 0;
  const s = reduce('s1', [ev('session.started', 'human:priya', { title: 't' })]);
  assert.equal(s.driver, 'priya');
});

test('handoff moves the wheel and records who had it when', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('session.started', 'human:priya', { title: 't' }),
    ev('run.handed_off', 'human:priya', { to: 'sam', note: 'off shift' })
  ]);
  assert.equal(s.driver, 'sam');
  assert.equal(s.handoffs.length, 1);
  assert.equal(s.handoffs[0].from, 'priya');
  assert.equal(s.handoffs[0].note, 'off shift');
});

test('claiming a step takes it from the agent, releasing gives it back', () => {
  seq = 0;
  const claimed = reduce('s1', [
    ev('session.started', 'human:priya', { agent: 'quorum' }),
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'migrate db' }] }),
    ev('step.claimed', 'human:sam', { id: 's1' })
  ]);
  assert.equal(claimed.steps[0].status, 'claimed');
  assert.equal(claimed.steps[0].ownerKind, 'human');
  assert.equal(claimed.steps[0].ownerName, 'sam');

  const released = reduce('s1', [
    ev('session.started', 'human:priya', { agent: 'quorum' }),
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'migrate db' }] }),
    ev('step.claimed', 'human:sam', { id: 's1' }),
    ev('step.released', 'human:sam', { id: 's1' })
  ]);
  assert.equal(released.steps[0].status, 'queued');
  assert.equal(released.steps[0].ownerKind, 'agent');
});

test('a finished step cannot be claimed out from under the record', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'x' }] }),
    ev('step.finished', 'agent:quorum', { id: 's1' }),
    ev('step.claimed', 'human:sam', { id: 's1' })
  ]);
  assert.equal(s.steps[0].status, 'done');
});

test('gate routing: only a named person can answer', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('gate.requested', 'agent:quorum', { id: 'g1', subject: 'drop table', answerableBy: ['priya'] }),
    ev('gate.resolved', 'human:mallory', { id: 'g1', approved: true })
  ]);
  assert.equal(s.gates[0].resolvedAt, null, 'an unlisted actor must not resolve it');
  assert.equal(s.status, 'blocked');

  const answered = reduce('s1', [
    ev('gate.requested', 'agent:quorum', { id: 'g1', subject: 'drop table', answerableBy: ['priya'] }),
    ev('gate.resolved', 'human:mallory', { id: 'g1', approved: true }),
    ev('gate.resolved', 'human:priya', { id: 'g1', approved: false })
  ]);
  assert.equal(answered.gates[0].by, 'priya');
  assert.equal(answered.gates[0].approved, false);
});

test('an agent cannot approve its own gate', () => {
  seq = 0;
  const s = reduce('s1', [
    ev('gate.requested', 'agent:quorum', { id: 'g1', subject: 'rm -rf /' }),
    ev('gate.resolved', 'agent:quorum', { id: 'g1', approved: true })
  ]);
  assert.equal(s.gates[0].resolvedAt, null, 'self-approval is the whole thing a gate exists to stop');
  assert.equal(s.status, 'blocked');
});

test('sessionAt replays the run as it stood at a moment', () => {
  seq = 0;
  const events = [
    ev('session.started', 'human:priya', { title: 't', agent: 'quorum' }),
    ev('plan.set', 'agent:quorum', { steps: [{ id: 's1', title: 'a' }] }),
    ev('step.started', 'agent:quorum', { id: 's1' }),
    ev('artifact.changed', 'agent:quorum', { path: 'a.js', added: 5 }),
    ev('step.finished', 'agent:quorum', { id: 's1' }),
    ev('run.finished', 'agent:quorum', {})
  ];
  const mid = sessionAt('s1', events, 3);
  assert.equal(mid.steps[0].status, 'running');
  assert.equal(mid.changes.length, 0, 'the file had not been touched yet at seq 3');
  assert.equal(mid.status, 'running');

  const end = sessionAt('s1', events, 6);
  assert.equal(end.status, 'done');
  assert.equal(end.changes.length, 1);
  assert.deepEqual(end, reduce('s1', events), 'scrubbing to the end is the present');
});

test('forkPoint carries the history up to the chosen moment', () => {
  seq = 0;
  const events = [
    ev('session.started', 'human:priya', { title: 'orig' }),
    ev('note.posted', 'human:priya', { text: 'keep' }),
    ev('note.posted', 'human:priya', { text: 'drop' })
  ];
  const carried = forkPoint(events, 2);
  assert.equal(carried.length, 2);
  assert.equal(carried[1].payload.text, 'keep');
  assert.ok(!('seq' in carried[0]), 'the fork renumbers from its own start');
  assert.ok(!('hash' in carried[0]), 'and rechains, since it is a different run');
});
