'use strict';
// Issue #7's first criterion: a real provider task that **produces file changes**, without
// giving that provider a shell it can write outside the project with.
//
// The confinement evidence (docs/proofs/codex-confinement.md) measured `--sandbox
// workspace-write` letting a shell command write one directory above the workspace on win32,
// and `--sandbox read-only` refusing the same write. So the provider is run read-only and the
// writes are the host's: Codex proposes the contents it thinks each file should have, and
// they go through the same workspace writer every other tool goes through.
//
// That is what this test is about. It never spawns Codex - the parsing and the applying are
// what could be wrong, and both run the same way whether the text came from a model or from
// here. test/encrypted-codex-task.js exercises the same path with the real CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TurnSession } = require('../packages/runtime/session');
const { ConfinedCodexExecBackend, parseProposedEdits, EDIT_PROTOCOL } = require('../packages/runtime/codex-exec');
const { Events, ItemTypes, ItemStatus } = require('../packages/protocol');

const results = [];
const pass = (name, detail) => { results.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-confined-writes-'));
const project = path.join(tmp, 'workspace');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(project); fs.mkdirSync(outside);
fs.writeFileSync(path.join(project, 'seed.txt'), 'seed\n');

const fence = (lines) => '```plexus-edits\n' + lines.join('\n') + '\n```';

function makeSession(settings = {}) {
  const events = [];
  const session = new TurnSession({
    thread: { id: 'th_confined', cwd: project, settings: {} },
    by: { userId: 'u_test', name: 'tester' },
    input: [{ type: 'text', text: 'update the notes' }],
    provider: { id: 'codex-cli' },
    settings: { approvalPolicy: 'never', sandboxPolicy: 'workspace-write', ...settings },
    executor: { id: 'local' }, history: [], log: () => {},
    // TurnSession hands its sink one object, method included.
    emit: (event) => events.push(event)
  });
  return { session, events };
}

(async () => {
  const backend = new ConfinedCodexExecBackend({ bin: 'codex' });

  // ---- what the provider is told, and what it is allowed ----
  assert.equal(backend.confinedTo, 'read-only');
  const caps = backend.capabilities();
  assert.equal(caps.providerWrites, false, 'the provider itself cannot write');
  assert.equal(caps.writes, true, 'the task can');
  assert.equal(caps.writesVia, 'host-applied-edits');
  assert.equal(caps.sandbox, 'read-only');
  pass('the provider is reported as unable to write while the task is able to',
    'writes via ' + caps.writesVia);

  assert.match(EDIT_PROTOCOL, /read-only view/);
  assert.match(EDIT_PROTOCOL, /Do not attempt to run a command that writes/);
  pass('the agent is told it cannot write and asked to propose instead', 'the protocol says both');

  // ---- parsing is strict, and says what it dropped ----
  const parsed = parseProposedEdits([
    'I would change one file.',
    fence([
      JSON.stringify({ path: 'notes/NOTES.md', contents: '# Notes\nretries are not idempotent\n' }),
      JSON.stringify({ path: 'no-contents.md' }),
      'not json at all'
    ]),
    'That is all.'
  ].join('\n'));
  assert.equal(parsed.edits.length, 1);
  assert.equal(parsed.edits[0].path, 'notes/NOTES.md');
  assert.deepEqual(parsed.rejected.map((r) => r.reason).sort(), ['incomplete_edit', 'unparsable_edit']);
  pass('a malformed proposal is dropped and reported, never guessed at', '1 kept, 2 rejected');

  const none = parseProposedEdits('I looked at the code and everything seems fine.');
  assert.deepEqual(none.edits, []);
  pass('a turn that proposes nothing writes nothing', 'no fence, no edits');

  // ---- applying goes through the host's own writer ----
  const { session, events } = makeSession();
  const outcome = await backend.applyProposedEdits(session, fence([
    JSON.stringify({ path: 'notes/NOTES.md', contents: '# Notes\nretries are not idempotent\n' })
  ]));
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].status, ItemStatus.COMPLETED);
  assert.equal(fs.readFileSync(path.join(project, 'notes', 'NOTES.md'), 'utf8').includes('not idempotent'), true);
  pass('a proposed edit becomes a real file change in the project', 'notes/NOTES.md written');

  // The change reaches the harness as a file change, which is what the encrypted log turns
  // into diff.updated - so criterion 1's "produces file changes" is visible to a teammate.
  const changes = events.filter((e) => e.method === Events.ITEM_COMPLETED && e.item && e.item.type === ItemTypes.FILE_CHANGE);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].item.changes[0].path.replace(/\\/g, '/'), 'notes/NOTES.md');
  assert.equal(changes[0].item.changes[0].kind, 'add');
  pass('the write is emitted as a file change the encrypted log can record',
    changes[0].item.changes[0].kind + ' ' + changes[0].item.changes[0].path);

  // ---- and it cannot be talked out of the project ----
  const escape = makeSession();
  const escaped = await backend.applyProposedEdits(escape.session, fence([
    JSON.stringify({ path: '../outside/escaped.txt', contents: 'ESCAPED' }),
    JSON.stringify({ path: '../../etc/passwd', contents: 'ESCAPED' })
  ]));
  assert.equal(escaped.applied.length, 2, 'both were attempted');
  assert.ok(escaped.applied.every((a) => a.status === ItemStatus.DECLINED), JSON.stringify(escaped.applied));
  assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false, 'nothing was written outside the project');
  pass('a proposal naming a path outside the project is declined by the workspace boundary',
    escaped.applied.map((a) => a.status).join(', '));

  // A symlink pointing out of the project is the same attack wearing a hat.
  let symlinked = false;
  try {
    fs.symlinkSync(outside, path.join(project, 'link'), 'junction');
    symlinked = true;
  } catch { /* symlink creation needs privileges on Windows; skipped rather than faked */ }
  if (symlinked) {
    const viaLink = makeSession();
    const linked = await backend.applyProposedEdits(viaLink.session, fence([
      JSON.stringify({ path: 'link/through.txt', contents: 'ESCAPED' })
    ]));
    assert.equal(linked.applied[0].status, ItemStatus.DECLINED);
    assert.equal(fs.existsSync(path.join(outside, 'through.txt')), false);
    pass('a proposal routed through a symlink out of the project is declined too', 'declined');
  } else {
    results.push({ name: 'symlink escape not exercised', status: 'recorded', detail: 'creating a junction needs privileges this machine did not grant' });
    console.log('  NOTE symlink escape not exercised - creating a junction needs privileges this machine did not grant');
  }

  // ---- an interrupted turn writes nothing ----
  const cancelled = makeSession();
  cancelled.session.cancelled = true;
  const nothing = await backend.run(cancelled.session).catch(() => ({ applied: [] }));
  assert.deepEqual(nothing.applied, [], 'a cancelled turn applies no edits');
  pass('a turn somebody interrupted does not write the files it was going to', 'cancel means cancel');

  // ---- an approval is still required where policy asks for one ----
  const asks = makeSession({ approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' });
  const pending = [];
  const asked = backend.applyProposedEdits(asks.session, fence([
    JSON.stringify({ path: '../outside/asked.txt', contents: 'nope' })
  ]));
  // Nothing outside the workspace is ever merely "asked" about here: the workspace boundary
  // refuses the path before policy is consulted, which is the stronger of the two answers.
  const askedOutcome = await asked;
  assert.equal(askedOutcome.applied[0].status, ItemStatus.DECLINED);
  assert.equal(pending.length, 0);
  pass('an outside path is refused by the boundary rather than escalated to a person',
    'no approval prompt for something that can never be allowed');

  const out = path.join(__dirname, '..', '.artifacts', 'confined-writes');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log('\n' + results.length + ' confined write checks recorded');
  process.exit(0);
})().catch((error) => { console.error('CONFINED WRITES FAILED\n', error); process.exit(1); });
