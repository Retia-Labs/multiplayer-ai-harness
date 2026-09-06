// Scripted two-client protocol smoke: hub + runtime (demo provider) + Alice + Bob.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');
const { TeamOps } = require('../packages/protocol');

function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m); }

class Client {
  constructor(url, name) { this.url = url; this.name = name; this.events = []; this.msgs = []; this.waiters = []; }
  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', name: this.name, org: 'local' })));
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'event') this.events.push(m);
        if (m.type === 'welcome') resolve(m);
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 15000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting: ' + pred.toString().slice(0, 80))), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  command(threadId, command, runtimeId) {
    const id = 'c_' + Math.random().toString(36).slice(2);
    this.send({ type: 'command', id, threadId, runtimeId, command });
    return this.wait((m) => m.type === 'command.result' && m.id === id).then((m) => { if (!m.ok) throw new Error(m.error); return m.result; });
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x');
  fs.writeFileSync(path.join(project, 'hello.js'), 'console.log(1)\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const addr = await hub.listen(0);
  const url = `ws://127.0.0.1:${addr.port}`;
  const rt = new Runtime({ hubUrl: url, userName: 'alice', dataDir: path.join(tmp, 'rt'), projects: [project], log: () => {} });
  await rt.start();

  const alice = new Client(url, 'alice'); await alice.connect();
  const bob = new Client(url, 'bob'); await bob.connect();

  alice.send({ type: TeamOps.TEAM_CREATE, name: 'Retia' });
  const team = (await alice.wait((m) => m.type === 'team')).team;
  assert(team && team.id, 'alice created a private team and owns it');

  alice.send({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: rt.pairingCode });
  await alice.wait((m) => m.type === 'runtime.paired');
  assert(rt.teamId === team.id, 'the host was paired with the code shown on its own console');

  alice.send({ type: TeamOps.INVITE_CREATE, teamId: team.id });
  const invite = (await alice.wait((m) => m.type === 'invitation')).invitation;
  bob.send({ type: TeamOps.INVITE_ACCEPT, code: invite.code });
  await bob.wait((m) => m.type === 'team');
  assert(true, 'bob joined the team through an expiring invitation');

  alice.send({ type: 'runtimes.list' });
  const rl = await alice.wait((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.online));
  assert(rl.runtimes[0].projects[0].name === 'project', 'runtime registered with its project in the fleet');

  const { thread } = await alice.command(null, { method: 'thread/start', cwd: project }, rt.id);
  assert(thread.id.startsWith('thr_'), 'thread/start created a thread owned by the runtime');
  await bob.wait((m) => m.type === 'thread.updated' && m.thread.id === thread.id);
  assert(true, 'bob learned about the new thread via broadcast');

  alice.send({ type: 'thread.subscribe', threadId: thread.id });
  bob.send({ type: 'thread.subscribe', threadId: thread.id });
  const pres = await bob.wait((m) => m.type === 'presence' && m.viewers.length === 2);
  assert(pres.viewers.map((v) => v.name).sort().join(',') === 'alice,bob', 'presence shows both viewers');

  await alice.command(thread.id, { method: 'turn/start', input: [{ type: 'text', text: 'Delete the build directory' }] });
  const req = await bob.wait((m) => m.type === 'event' && m.method === 'item/commandExecution/requestApproval');
  assert(req.command === 'rm -rf build', 'bob received the approval request for rm -rf build');
  const tu = await bob.wait((m) => m.type === 'thread.updated' && m.thread.status.activeFlags && m.thread.status.activeFlags.includes('waitingOnApproval'));
  assert(tu.thread.pendingApproval.requestId === req.requestId, 'thread status shows waitingOnApproval with the pending request');

  await bob.command(thread.id, { method: 'approval/resolve', requestId: req.requestId, decision: 'accept' });
  const resolved = await alice.wait((m) => m.type === 'event' && m.method === 'serverRequest/resolved');
  assert(resolved.by.name === 'bob' && resolved.decision === 'accept', 'alice saw that bob approved (serverRequest/resolved attributed to bob)');
  const done = await alice.wait((m) => m.type === 'event' && m.method === 'turn/completed', 30000);
  assert(done.status === 'completed', 'turn completed');
  assert(!fs.existsSync(path.join(project, 'build')), 'the approved command actually ran (build/ deleted)');
  const cmdItem = alice.events.find((e) => e.method === 'item/completed' && e.item.type === 'commandExecution' && e.item.command === 'rm -rf build');
  assert(cmdItem && cmdItem.item.status === 'completed' && cmdItem.item.exitCode === 0, 'commandExecution item completed with exit 0');
  assert(alice.events.filter((e) => e.method === 'turn/plan/updated').length >= 3, 'plan updates streamed');
  await bob.wait((m) => m.type === 'event' && m.method === 'turn/completed', 30000);
  const aSeqs = alice.events.map((e) => e.seq), bSeqs = bob.events.map((e) => e.seq);
  if (JSON.stringify(aSeqs) !== JSON.stringify(bSeqs)) { console.log("alice", aSeqs.join(","), "\nbob  ", bSeqs.join(",")); console.log("alice first:", alice.events[0].method, "bob first:", bob.events[0].method); }
  assert(JSON.stringify(aSeqs) === JSON.stringify(bSeqs), "both clients received the identical ordered event log");

  // Late joiner replays from the log
  const carol = new Client(url, 'carol'); await carol.connect();
  carol.send({ type: 'thread.subscribe', threadId: thread.id });
  const snap = await carol.wait((m) => m.type === 'thread.snapshot');
  assert(snap.events.length === aSeqs.length && snap.events[snap.events.length - 1].method === 'turn/completed', 'late joiner got the full snapshot');

  // HTTP polling fallback
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/threads/${thread.id}/events?after=${aSeqs.length - 2}`);
  const j = await res.json();
  assert(j.events.length === 2 && j.nextSeq === aSeqs.length, 'HTTP polling fallback returns events after a cursor');

  // Steering while running + interrupt
  await alice.command(thread.id, { method: 'turn/start', input: [{ type: 'text', text: 'Tell me a joke' }] });
  const ts = await bob.wait((m) => m.type === 'event' && m.method === 'turn/started' && m.seq > aSeqs.length);
  const st = await bob.command(thread.id, { method: 'turn/steer', input: [{ type: 'text', text: 'make it about crabs' }], expectedTurnId: ts.turnId });
  assert(st.turnId === ts.turnId, 'bob steered alice\'s running turn');
  const steerMsg = await alice.wait((m) => m.type === 'event' && m.method === 'item/completed' && m.item.type === 'userMessage' && m.item.delivery === 'steer');
  assert(steerMsg.item.by.name === 'bob', 'steer rendered as a userMessage attributed to bob');
  await alice.wait((m) => m.type === 'event' && m.method === 'turn/completed' && m.turnId === ts.turnId, 30000);

  // git ops through the runtime
  fs.writeFileSync(path.join(project, 'hello.js'), 'console.log(2)\n');
  const diff = await alice.command(thread.id, { method: 'git/diff' });
  assert(diff.files.some((f) => f.path === 'hello.js') && diff.files.some((f) => f.path === 'build/out.txt' && f.status === 'deleted'), 'git/diff via runtime lists the modified and deleted files');
  const c = await bob.command(thread.id, { method: 'git/commit', message: 'from bob' });
  assert(c.ok, 'git/commit via runtime succeeded');

  // ---- team awareness + collision radar ----
  // Alice's thread creates NOTES.md; a second thread on the same project then tries to create it too.
  await alice.command(thread.id, { method: 'turn/start', input: [{ type: 'text', text: 'Create NOTES.md' }] });
  await alice.wait((m) => m.type === 'event' && m.method === 'turn/completed' && m.seq > (state => state)(0) && alice.events.some((e) => e.method === 'item/completed' && e.item.type === 'fileChange'), 30000);
  const act = await bob.wait((m) => m.type === 'workspace.activity' && m.threads.some((t) => t.threadId === thread.id && t.files.some((f) => f.path === 'NOTES.md')));
  assert(true, 'hub tracks NOTES.md as touched by alice\'s thread (workspace.activity)');
  const { thread: t2 } = await bob.command(null, { method: 'thread/start', cwd: project }, rt.id);
  bob.send({ type: 'thread.subscribe', threadId: t2.id });
  await bob.wait((m) => m.type === 'thread.snapshot' && m.thread.id === t2.id);
  await new Promise((r) => setTimeout(r, 200)); // let the hub push the activity snapshot to the runtime
  await bob.command(t2.id, { method: 'turn/start', input: [{ type: 'text', text: 'Create NOTES.md' }] });
  const col = await bob.wait((m) => m.type === 'event' && m.threadId === t2.id && m.method === 'item/fileChange/requestApproval', 30000);
  assert(/collision/.test(col.reason) && col.collision && col.collision.threadId === thread.id, 'second thread writing the same file is escalated to approval with a collision reason: ' + col.reason);
  await bob.command(t2.id, { method: 'approval/resolve', requestId: col.requestId, decision: 'accept' });
  await bob.wait((m) => m.type === 'event' && m.threadId === t2.id && m.method === 'turn/completed', 30000);
  const ov = await alice.wait((m) => m.type === 'workspace.activity' && m.overlaps.some((o) => o.path === 'NOTES.md' && o.threads.length === 2));
  assert(ov.overlaps[0].severity === 'collision', 'hub reports the overlap between the two threads as a collision');

  // ---- handoff ----
  await alice.command(thread.id, { method: 'thread/assign', assignee: { userId: 'u_bob', name: 'bob', color: '#c026d3' }, note: 'please review and merge' });
  const asg = await bob.wait((m) => m.type === 'thread.updated' && m.thread.id === thread.id && m.thread.assignee && m.thread.assignee.name === 'bob');
  assert(asg.thread.handoffNote === 'please review and merge', 'thread handed off to bob with a note (attributed event + thread.updated)');

  rt.stop(); await hub.close();
  console.log('\nprotocol smoke passed ✅');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED', e); process.exit(1); });
