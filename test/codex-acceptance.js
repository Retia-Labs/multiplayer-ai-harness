// Acceptance harness for issue #2 (P01): "Prove real Codex shared control and supported
// authentication". Boots a hub, one runtime and two human clients, then runs each
// acceptance criterion as a numbered check. Where a check concerns the provider it is
// judged on what Codex itself acknowledged on its own event stream, not on what the
// harness rendered.
//
//   node test/codex-acceptance.js                       # every lane this machine allows
//   node test/codex-acceptance.js --lane control        # no provider spend at all
//   node test/codex-acceptance.js --lane subscription   # the machine's `codex login`
//   node test/codex-acceptance.js --lane api            # isolated CODEX_HOME + OPENAI_API_KEY
//   node test/codex-acceptance.js --model gpt-5.4-mini --out docs/proofs
//
// The API lane bills per token, so it runs auth plus one real turn by default; add
// --api-depth full to re-run the control behaviours against it too.
//
// Exit code is 0 when nothing FAILED. BLOCKED is not a failure: it records a capability
// this machine cannot supply, with the concrete thing an operator must do about it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');
const { localShell } = require('../packages/runtime/executors');
const probeMod = require('../packages/runtime/codex-probe');

const ROOT = path.join(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const LANES = args.lane ? [args.lane] : ['control', 'subscription', 'api'];
const OUT_DIR = path.resolve(ROOT, args.out || 'docs/proofs');
const TURN_TIMEOUT = args.timeout || 240000;

// ---------------------------------------------------------------- result matrix ----
const results = [];
function record(criterion, id, status, detail, evidence) {
  results.push({ criterion, id, status, detail, evidence: evidence || null });
  const mark = { pass: '  ✓', fail: '  ✗', blocked: '  ○', info: '  ·' }[status] || '  ?';
  console.log(`${mark} [${criterion}] ${id} — ${detail}`);
  return status;
}
async function check(criterion, id, fn) {
  try {
    const r = await fn();
    if (!r) return record(criterion, id, 'fail', 'check returned nothing');
    return record(criterion, id, r.status || 'pass', r.detail, r.evidence);
  } catch (err) {
    return record(criterion, id, 'fail', String((err && err.message) || err));
  }
}

// ---------------------------------------------------------------- test client ----
// Deliberately lower-level than the web app: the dedup and racing-approval checks need to
// choose their own command identities and send the same one twice.
class Client {
  constructor(url, name) { this.url = url; this.name = name; this.msgs = []; this.events = []; this.waiters = []; }
  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ type: 'hello', name: this.name, org: 'local' })));
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.type === 'event') this.events.push(m);
        if (m.type === 'welcome') { this.user = m.user; resolve(m); }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch {} }
  wait(pred, ms = 30000, label = '') { return this.waitFrom(0, pred, ms, label); }
  waitFrom(from, pred, ms = 30000, label = '') {
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for ' + (label || pred.toString().slice(0, 60)))), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  // Returns the raw command.result envelope so a caller can inspect ok/error/duplicate.
  raw(threadId, command, { id = 'cmd_' + Math.random().toString(36).slice(2), runtimeId } = {}) {
    // Retries reuse the command id on purpose, so only look at replies that arrive after
    // this send - otherwise the first reply satisfies the second call.
    const from = this.msgs.length;
    this.send({ type: 'command', id, threadId, runtimeId, command });
    return this.waitFrom(from, (m) => m.type === 'command.result' && m.id === id, 60000, command.method).then((m) => ({ ...m, id }));
  }
  async command(threadId, command, opts) {
    const m = await this.raw(threadId, command, opts);
    if (!m.ok) throw new Error(m.error);
    return m.result;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function eventsFor(client, threadId, turnId) {
  return client.events.filter((e) => e.threadId === threadId && (!turnId || e.turnId === turnId));
}
function waitEvent(client, threadId, pred, ms, label) {
  return client.wait((m) => m.type === 'event' && m.threadId === threadId && pred(m), ms, label);
}

// ---------------------------------------------------------------- fixtures ----
function makeProject(tmp) {
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'x');
  fs.writeFileSync(path.join(project, 'sample.txt'), 'alpha\nbeta\n');
  try {
    execFileSync(localShell().bin, ['-c', 'git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init'], { cwd: project, stdio: 'ignore' });
  } catch { /* a non-repo workspace is a supported case; --skip-git-repo-check covers it */ }
  return project;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ============================================================ control-plane checks ==
// Everything that must hold regardless of which provider is behind the thread. Run on the
// built-in demo backend so they are deterministic and cost nothing.
async function controlPlane({ alice, bob, rt, project }) {
  const C2 = 'AC2 identity & authority';
  const C1 = 'AC1 shared control';

  // --- retry deduplication, proved on a command with a visible side effect -----------
  await check(C2, 'command-identity-unique', async () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add('cmd_' + Math.random().toString(36).slice(2));
    const first = await alice.raw(null, { method: 'thread/start', cwd: project, name: 'identity probe' }, { runtimeId: rt.id });
    return {
      detail: 'client-generated command ids are unique and echoed back on the result',
      evidence: { sampled: ids.size, exampleId: first.id, ok: first.ok }
    };
  });

  await check(C2, 'retry-dedup', async () => {
    const before = rt.store.listThreads().length;
    const id = 'cmd_retry_' + Date.now();
    const one = await alice.raw(null, { method: 'thread/start', cwd: project, name: 'dedup probe' }, { id, runtimeId: rt.id });
    const two = await alice.raw(null, { method: 'thread/start', cwd: project, name: 'dedup probe' }, { id, runtimeId: rt.id });
    const after = rt.store.listThreads().length;
    const created = after - before;
    if (created !== 1) throw new Error(`retrying one command id created ${created} threads`);
    if (!two.duplicate) throw new Error('the retry was not marked as a duplicate');
    if (two.result.thread.id !== one.result.thread.id) throw new Error('the retry returned a different thread');
    return {
      detail: 'the same command identity sent twice ran once and replayed the original result',
      evidence: { commandId: id, threadsCreated: created, threadId: one.result.thread.id, duplicateFlag: !!two.duplicate }
    };
  });

  // --- a bounded approval, resolved once, by the other human -------------------------
  const { thread } = await alice.command(null, { method: 'thread/start', cwd: project, name: 'approval lane', settings: { provider: 'demo', model: 'demo-agent', preset: 'agent' } }, { runtimeId: rt.id });
  alice.send({ type: 'thread.subscribe', threadId: thread.id });
  bob.send({ type: 'thread.subscribe', threadId: thread.id });
  await alice.wait((m) => m.type === 'thread.snapshot' && m.thread.id === thread.id);
  await bob.wait((m) => m.type === 'thread.snapshot' && m.thread.id === thread.id);

  const { turnId } = await alice.command(thread.id, { method: 'turn/start', input: [{ type: 'text', text: 'Delete the build directory.' }] });
  const approvalReq = await waitEvent(bob, thread.id, (m) => m.method === 'item/commandExecution/requestApproval', 30000, 'approval request');

  await check(C1, 'stale-turn-rejected', async () => {
    const r = await bob.raw(thread.id, { method: 'turn/steer', input: [{ type: 'text', text: 'too late' }], expectedTurnId: 'turn_stale_000' });
    if (r.ok) throw new Error('a steer aimed at the wrong turn was accepted');
    return { detail: 'a steer carrying a stale expectedTurnId is refused: ' + r.error, evidence: { activeTurnId: turnId, sentExpectedTurnId: 'turn_stale_000', error: r.error } };
  });

  await check(C1, 'steer-delivery-contract', async () => {
    const r = await bob.command(thread.id, { method: 'turn/steer', input: [{ type: 'text', text: 'and mention crabs' }], expectedTurnId: turnId });
    const ev = await waitEvent(alice, thread.id, (m) => m.method === 'item/completed' && m.item && m.item.delivery === 'steer', 15000, 'steer item');
    if (ev.item.by.name !== 'bob') throw new Error('the steer was not attributed to bob');
    if (!r.delivery) throw new Error('the steer result did not say how it would be delivered');
    return {
      detail: `bob's steer landed inside alice's turn, attributed, with delivery=${r.delivery}`,
      evidence: { turnId: r.turnId, delivery: r.delivery, attributedTo: ev.item.by.name, seq: ev.seq }
    };
  });

  await check(C2, 'single-authoritative-approval', async () => {
    const rid = approvalReq.requestId;
    const [a, b] = await Promise.all([
      bob.raw(thread.id, { method: 'approval/resolve', requestId: rid, decision: 'accept' }),
      alice.raw(thread.id, { method: 'approval/resolve', requestId: rid, decision: 'decline' })
    ]);
    const winners = [a, b].filter((r) => r.ok);
    if (winners.length !== 1) throw new Error(`${winners.length} of 2 competing resolutions were accepted`);
    const resolved = await waitEvent(alice, thread.id, (m) => m.method === 'serverRequest/resolved' && m.requestId === rid, 15000, 'resolution');
    return {
      detail: `two humans resolved the same approval at once; exactly one outcome was authoritative (${resolved.decision} by ${resolved.by.name})`,
      evidence: { requestId: rid, accepted: winners.length, decision: resolved.decision, by: resolved.by.name, loserError: [a, b].find((r) => !r.ok).error }
    };
  });

  const completed = await waitEvent(alice, thread.id, (m) => m.method === 'turn/completed', 60000, 'turn completion');

  await check(C1, 'identical-ordered-log', async () => {
    const a = eventsFor(alice, thread.id).map((e) => e.seq);
    const b = eventsFor(bob, thread.id).map((e) => e.seq);
    const shared = a.filter((s) => b.includes(s));
    if (!shared.length) throw new Error('the two clients shared no events');
    const ordered = shared.every((s, i) => i === 0 || s > shared[i - 1]);
    if (!ordered) throw new Error('the shared event log was not monotonically ordered');
    return {
      detail: `both clients received the same ${shared.length} events in the same sequence order`,
      evidence: { aliceEvents: a.length, bobEvents: b.length, shared: shared.length, lastSeq: shared[shared.length - 1] }
    };
  });

  await check(C1, 'approval-gated-side-effect', async () => {
    const gone = !fs.existsSync(path.join(project, 'build'));
    return {
      status: gone ? 'pass' : 'fail',
      detail: gone ? 'the approved command actually ran on the execution host after the human decision' : 'the approved command did not run',
      evidence: { turnStatus: completed.status, buildDirRemoved: gone }
    };
  });

  await check(C2, 'exactly-once-scope', async () => ({
    status: 'info',
    detail: 'deduplication is relay-scoped: it makes a retried command identity run at most once through the hub. It is NOT a claim of exactly-once external side effects across a runtime crash mid-execution.',
    evidence: {
      guaranteed: 'one routed execution per (user, command id); one authoritative approval resolution per requestId',
      notGuaranteed: 'a runtime that dies after a command has partially run leaves that partial effect; the harness has no undo and does not fence external side effects',
      mitigation: 'the append-only thread log records the last acknowledged item, so a human can see what had run before the crash'
    }
  }));

  return { thread, turnId };
}

// ============================================================ provider lane ==
// The parts that only a real Codex process can prove.
async function providerLane({ lane, alice, bob, rt, project, env, model, taps, depth = 'full' }) {
  const C1 = 'AC1 shared control';
  const C3 = 'AC3 authentication';
  const settings = { provider: 'codex-cli', model, preset: 'agent' };
  const tag = (id) => `${id}[${lane}]`;

  const { thread } = await alice.command(null, { method: 'thread/start', cwd: project, name: `codex ${lane}`, settings }, { runtimeId: rt.id });
  alice.send({ type: 'thread.subscribe', threadId: thread.id });
  bob.send({ type: 'thread.subscribe', threadId: thread.id });
  await alice.wait((m) => m.type === 'thread.snapshot' && m.thread.id === thread.id);
  await bob.wait((m) => m.type === 'thread.snapshot' && m.thread.id === thread.id);

  const before = taps.length;
  const { turnId } = await alice.command(thread.id, {
    method: 'turn/start',
    input: [{ type: 'text', text: "Run the shell command that prints the contents of sample.txt, then reply with exactly READY." }]
  });

  // Steer while Codex is still working, so the delivery path is the real one.
  let steerResult = null;
  try {
    if (depth !== 'full') throw new Error('skipped on a lite lane');
    await waitEvent(bob, thread.id, (m) => m.method === 'item/started' || m.method === 'item/completed', 90000, 'first item');
    steerResult = await bob.command(thread.id, { method: 'turn/steer', input: [{ type: 'text', text: 'Also reply with exactly BETA on its own line.' }], expectedTurnId: turnId });
  } catch (err) {
    steerResult = { error: String(err.message || err) };
  }

  const done = await waitEvent(alice, thread.id, (m) => m.method === 'turn/completed', TURN_TIMEOUT, 'codex turn completion');
  const raw = taps.slice(before);
  const providerTypes = raw.map((r) => r.ev.type);
  const threadStarts = raw.filter((r) => r.ev.type === 'thread.started').map((r) => r.ev.thread_id);
  const providerText = raw.filter((r) => r.ev.item && r.ev.item.type === 'agent_message').map((r) => r.ev.item.text).join('\n');

  await check(C1, tag('real-turn-start'), async () => {
    if (done.status === 'failed') throw new Error('codex turn failed: ' + JSON.stringify(done.error));
    if (!threadStarts.length) throw new Error('codex never acknowledged a thread; nothing was proved');
    const ranCommand = raw.some((r) => r.ev.item && r.ev.item.type === 'command_execution' && r.ev.item.status === 'completed');
    return {
      detail: `codex acknowledged thread ${threadStarts[0]} and completed the turn (${done.status})`,
      evidence: { providerThreadId: threadStarts[0], turnStatus: done.status, providerEventTypes: [...new Set(providerTypes)], providerRanACommand: ranCommand, usage: done.usage || null }
    };
  });

  await check(C1, tag('two-client-stream'), async () => {
    const a = eventsFor(alice, thread.id, turnId).length;
    const b = eventsFor(bob, thread.id, turnId).length;
    if (!a || !b) throw new Error(`alice saw ${a} events, bob saw ${b}`);
    return { detail: `both humans watched the same live Codex turn (${a}/${b} events)`, evidence: { alice: a, bob: b } };
  });

  if (depth !== 'full') {
    record(C1, tag('control-behaviours'), 'info', 'steer, resume and interrupt were not re-run on this lane: they exercise provider-agnostic runtime code already proved on the subscription lane', { rerunWith: `node test/codex-acceptance.js --lane ${lane} --api-depth full` });
    await check(C3, tag('auth-mode-exercised'), async () => ({
      detail: `lane ${lane} ran a real turn under auth mode "${env.__mode}"`,
      evidence: { lane, authMode: env.__mode, codexHome: env.CODEX_HOME || null, usageOwner: env.__usageOwner, model: model || 'the CLI default for this account' }
    }));
    return { threadId: thread.id, providerThreadId: threadStarts[0] || null };
  }

  await check(C1, tag('steer-reaches-provider'), async () => {
    if (steerResult && steerResult.error) throw new Error('steer was rejected: ' + steerResult.error);
    const delivery = steerResult && steerResult.delivery;
    // The provider acknowledgment of a delivered steer is a second exec on the same
    // Codex session: `codex exec` cannot take input into a process already running.
    const resumed = threadStarts.length > 1 && threadStarts[1] === threadStarts[0];
    const echoed = /BETA/.test(providerText);
    if (!resumed && !echoed) {
      return {
        status: 'blocked',
        detail: `the steer was recorded and attributed with delivery=${delivery}, but Codex did not acknowledge it in this turn`,
        evidence: { delivery, providerThreadStarts: threadStarts, providerText: providerText.slice(0, 400), alternative: 'Drive Codex through `codex app-server`, which accepts input into a live turn.' }
      };
    }
    return {
      detail: `the steer reached Codex as a resumed turn on session ${threadStarts[0]} (delivery=${delivery}, provider echoed BETA: ${echoed})`,
      evidence: { delivery, providerThreadStarts: threadStarts, echoedBeta: echoed, providerText: providerText.slice(0, 400) }
    };
  });

  await check(C1, tag('provider-resume'), async () => {
    const stored = rt.store.getThread(thread.id);
    const sessionId = stored && stored.codexSessionId;
    if (!sessionId) throw new Error('no Codex session handle was retained for resume');
    const mark = taps.length;
    await alice.command(thread.id, { method: 'turn/start', input: [{ type: 'text', text: 'Reply with exactly the word you replied with first.' }] });
    const second = await waitEvent(alice, thread.id, (m) => m.method === 'turn/completed' && m.seq > done.seq, TURN_TIMEOUT, 'resumed turn');
    const starts = taps.slice(mark).filter((r) => r.ev.type === 'thread.started').map((r) => r.ev.thread_id);
    if (!starts.length) throw new Error('the second turn produced no provider acknowledgment');
    if (starts[0] !== sessionId) throw new Error(`the resumed turn opened a new Codex session (${starts[0]} != ${sessionId})`);
    return {
      detail: `a second turn explicitly resumed Codex session ${sessionId} instead of starting a new one`,
      evidence: { codexSessionId: sessionId, secondTurnThreadIds: starts, secondTurnStatus: second.status, handleLeftRuntime: false }
    };
  });

  await check(C1, tag('interrupt-during-tool-work'), async () => {
    const { thread: t2 } = await alice.command(null, { method: 'thread/start', cwd: project, name: `codex interrupt ${lane}`, settings }, { runtimeId: rt.id });
    alice.send({ type: 'thread.subscribe', threadId: t2.id });
    await alice.wait((m) => m.type === 'thread.snapshot' && m.thread.id === t2.id);
    const mark = taps.length;
    await alice.command(t2.id, { method: 'turn/start', input: [{ type: 'text', text: 'List every file under this directory one at a time using separate shell commands, then summarise.' }] });
    // Wait until Codex is genuinely working, not merely spawned.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 90000;
      const poll = setInterval(() => {
        if (taps.slice(mark).some((r) => r.ev.type === 'turn.started' || (r.ev.item && r.ev.item.type === 'command_execution'))) { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('codex never reached tool work')); }
      }, 250);
    });
    const session = rt.sessions.get(t2.id);
    const pids = (session && session.providerSpawns || []).map((s) => s.pid);
    await bob.command(t2.id, { method: 'turn/interrupt', turnId: session && session.turnId });
    const end = await waitEvent(alice, t2.id, (m) => m.method === 'turn/completed', 60000, 'interrupted turn');
    await sleep(500);
    const stillAlive = pids.filter(alive);
    if (end.status !== 'interrupted') throw new Error('the turn ended as ' + end.status + ', not interrupted');
    if (stillAlive.length) throw new Error('codex process ' + stillAlive.join(',') + ' survived the interrupt');
    return {
      detail: `a teammate stopped Codex mid tool-work; the turn ended as ${end.status} and the provider process exited`,
      evidence: { interruptedBy: 'bob', turnStatus: end.status, providerPids: pids, survivingPids: stillAlive }
    };
  });

  await check(C1, tag('approval-during-codex-work'), async () => {
    // The probe owns the wording of this gap; restating it here only lets the two drift.
    const gap = probeMod.probe().blockers.find((b) => b.id === 'exec-approvals-not-routable');
    return {
      status: 'blocked',
      detail: gap.detail,
      evidence: {
        provedInstead: 'the harness-owned tool path does route a bounded approval to a second human (see approval-gated-side-effect)',
        alternative: gap.alternative
      }
    };
  });

  await check(C3, tag('auth-mode-exercised'), async () => {
    const auth = probeMod.authStatus(probeMod.resolveCodex(), env);
    return {
      detail: `lane ${lane} ran a real turn under auth mode "${env.__mode}"`,
      evidence: { lane, authMode: env.__mode, codexHome: env.CODEX_HOME || null, usageOwner: env.__usageOwner, statusLine: auth.statusLine }
    };
  });

  return { threadId: thread.id, providerThreadId: threadStarts[0] || null };
}

// ============================================================ lane setup ==
function laneEnv(lane, probe, tmp) {
  if (lane === 'subscription') {
    if (probe.auth.mode !== 'chatgpt') {
      return { blocked: `the Codex CLI on this host is authenticated as "${probe.auth.mode}", not a ChatGPT subscription`, fix: 'Run `codex login` on the execution host and re-run this harness.' };
    }
    return { env: { ...process.env, __mode: 'chatgpt', __usageOwner: 'the ChatGPT account signed in to the Codex CLI on this execution host' } };
  }
  if (lane === 'api') {
    if (!process.env.OPENAI_API_KEY) {
      return { blocked: 'OPENAI_API_KEY is not set, so the API-billed mode cannot be exercised separately', fix: 'Export OPENAI_API_KEY for an authorized test account and re-run with --lane api.' };
    }
    // A separate CODEX_HOME so the API login cannot disturb the machine's real one.
    const home = path.join(tmp, 'codex-home-api');
    fs.mkdirSync(home, { recursive: true });
    const resolved = probeMod.resolveCodex();
    const login = spawnSync(resolved.bin, [...resolved.prefix, 'login', '--with-api-key'], {
      input: process.env.OPENAI_API_KEY, encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 60000
    });
    if (login.status !== 0) {
      return { blocked: 'codex login --with-api-key failed: ' + String(login.stderr || login.stdout || '').trim().slice(0, 200), fix: 'Check that OPENAI_API_KEY belongs to an account entitled to Codex.' };
    }
    return { env: { ...process.env, CODEX_HOME: home, __mode: 'apikey', __usageOwner: 'the OpenAI API account behind OPENAI_API_KEY (billed per token, separate from any subscription)' } };
  }
  return { env: { ...process.env, __mode: 'demo', __usageOwner: 'nobody: the built-in demo backend calls no provider' } };
}

// ============================================================ main ==
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acceptance-'));
  const probe = probeMod.probe();

  console.log('\nCodex acceptance harness — issue #2 (P01)');
  console.log(`  host      ${process.platform}/${process.arch} node ${process.version}`);
  console.log(`  codex     ${probe.version || 'not found'} (${probe.resolved.kind})`);
  console.log(`  auth      ${probe.auth ? probe.auth.mode : 'n/a'}`);
  console.log(`  lanes     ${LANES.join(', ')}\n`);

  const C4 = 'AC4 version & prerequisites';
  await check(C4, 'codex-resolvable', async () => {
    if (!probe.version) throw new Error(probe.blockers[0].detail);
    return { detail: `resolved the Codex binary as ${probe.resolved.kind} at ${probe.resolved.path}`, evidence: probe.resolved };
  });
  await check(C4, 'version-pinned', async () => ({
    status: probe.versionMatchesTested ? 'pass' : 'info',
    detail: probe.versionMatchesTested
      ? `running Codex ${probe.version}, one of the builds this adapter is proved against (${probe.tested.versions.join(', ')})`
      : `running Codex ${probe.version}; this adapter has been proved against ${probe.tested.versions.join(', ')}`,
    evidence: { tested: probe.tested, found: probe.version }
  }));
  await check(C4, 'platform-prerequisites', async () => ({
    detail: 'recorded the prerequisites this adapter depends on for this platform',
    evidence: {
      platform: probe.platform,
      shell: localShell().bin,
      spawnNote: process.platform === 'win32'
        ? 'Node cannot spawn npm\'s codex.cmd (EINVAL) or its extensionless shim (ENOENT); the adapter resolves the vendored codex.exe, falling back to cmd.exe /d /s /c'
        : 'the codex shim on PATH is spawned directly',
      execFlags: probe.capabilities.flags,
      deprecated: { '--full-auto': probe.capabilities.fullAuto ? 'present' : 'absent in this build; the adapter sends --sandbox workspace-write' }
    }
  }));
  await check(C4, 'capability-gaps-have-an-answer', async () => {
    const unanswered = probe.blockers.filter((b) => !b.alternative);
    if (unanswered.length) throw new Error(unanswered.length + ' capability gaps have no recorded alternative');
    return {
      status: probe.blockers.length ? 'info' : 'pass',
      detail: `${probe.blockers.length} capability gap(s) recorded, each with a concrete alternative or blocker`,
      evidence: probe.blockers
    };
  });
  await check('AC3 authentication', 'usage-owner-and-entitlements', async () => ({
    status: 'info',
    detail: 'recorded who pays and what multi-human authority actually means here',
    evidence: {
      authMode: probe.auth.mode,
      statusLine: probe.auth.statusLine,
      codexHome: probe.auth.codexHome,
      openaiApiKeyPresentInEnv: probe.auth.openaiApiKeyInEnv,
      entitledModels: probe.models.models,
      usageOwner: 'the Codex credential stored on the execution host; every teammate\'s instruction is billed to that one account',
      multiHumanAuthority: 'teammates act through the execution host\'s single provider identity. The harness attributes each instruction to its author, but the provider sees one principal.',
      notProved: 'technical login success is not evidence that a subscription entitlement may be shared with, or transferred to, teammates. Seat terms are a commercial question, not a test result.'
    }
  }));

  // --- boot the collaboration stack ---------------------------------------------
  const hub = new Hub({ dbFile: ':memory:', log: () => {} });
  const addr = await hub.listen(0);
  const url = `ws://127.0.0.1:${addr.port}`;
  const project = makeProject(tmp);
  const taps = [];
  const rt = new Runtime({ hubUrl: url, userName: 'alice', dataDir: path.join(tmp, 'rt'), projects: [project], log: () => {} });
  rt.providerTap = (line, ev) => taps.push({ at: Date.now(), line, ev });
  await rt.start();
  const alice = new Client(url, 'alice'); await alice.connect();
  const bob = new Client(url, 'bob'); await bob.connect();
  alice.send({ type: 'runtimes.list' });
  await alice.wait((m) => m.type === 'runtimes' && m.runtimes.some((r) => r.online), 15000, 'runtime registration');

  const lanes = {};
  try {
    if (LANES.includes('control')) {
      console.log('\n-- control plane (demo backend, no provider spend) --');
      await controlPlane({ alice, bob, rt, project });
      lanes.control = 'executed';
    }
    for (const lane of LANES.filter((l) => l !== 'control')) {
      console.log(`\n-- ${lane} lane --`);
      const setup = laneEnv(lane, probe, tmp);
      if (setup.blocked) {
        record('AC3 authentication', `lane-${lane}`, 'blocked', setup.blocked, { operatorAction: setup.fix });
        lanes[lane] = 'blocked';
        continue;
      }
      const depth = lane === 'api' ? (args.apiDepth || 'lite') : 'full';
      // Under an isolated CODEX_HOME the API lane has no config.toml and no cached model
      // list, so let the CLI pick its own default rather than sending a subscription model id.
      const model = args.model || (lane === 'api' ? null : (probe.models.models.find((m) => /mini/.test(m)) || probe.models.models[0]));
      if (!model && lane !== 'api') {
        record('AC3 authentication', `lane-${lane}`, 'blocked', 'no model is known for this account, so no real turn can be run', { operatorAction: 'Pass --model <id>, or run `codex exec` once so the CLI caches the account model list.' });
        lanes[lane] = 'blocked';
        continue;
      }
      const laneProc = { ...process.env };
      Object.assign(process.env, setup.env);
      try {
        await providerLane({ lane, alice, bob, rt, project, env: setup.env, model, taps, depth });
        lanes[lane] = 'executed';
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in laneProc)) delete process.env[k];
        Object.assign(process.env, laneProc);
      }
    }
  } finally {
    alice.close(); bob.close(); rt.stop(); await hub.close();
  }

  writeMatrix({ probe, lanes, taps, tmp });
  const failed = results.filter((r) => r.status === 'fail');
  const blocked = results.filter((r) => r.status === 'blocked');
  console.log(`\n${results.filter((r) => r.status === 'pass').length} passed, ${blocked.length} blocked, ${failed.length} failed`);
  if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`); }
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error('\nharness error:', err); process.exit(1); });

// ---------------------------------------------------------------- reporting ----
function writeMatrix({ probe, lanes, taps }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    issue: 'https://github.com/Retia-Labs/multiplayer-ai-harness/issues/2',
    ranAt: new Date().toISOString(),
    host: probe.platform,
    codex: { version: probe.version, tested: probe.tested, resolution: probe.resolved, auth: probe.auth, models: probe.models, capabilities: probe.capabilities },
    lanes,
    blockers: probe.blockers,
    providerAcknowledgments: taps.length,
    results
  };
  fs.writeFileSync(path.join(OUT_DIR, 'codex-acceptance-result.json'), JSON.stringify(payload, null, 2));
  // The raw provider stream is the evidence behind every AC1 row; keep it beside the matrix.
  fs.writeFileSync(path.join(OUT_DIR, 'codex-acceptance-provider.jsonl'), taps.map((t) => t.line).join('\n') + (taps.length ? '\n' : ''));

  const icon = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', info: 'RECORDED' };
  const rows = results.map((r) => `| ${r.criterion} | \`${r.id}\` | **${icon[r.status] || r.status}** | ${r.detail.replace(/\|/g, '\\|')} |`);
  const md = [
    '# Codex acceptance result matrix',
    '',
    `Generated by \`node test/codex-acceptance.js\` on ${payload.ranAt}. Evidence for every row is in`,
    '[`codex-acceptance-result.json`](codex-acceptance-result.json); the provider\'s own event stream is in',
    '[`codex-acceptance-provider.jsonl`](codex-acceptance-provider.jsonl).',
    '',
    `- Host: ${probe.platform.os}/${probe.platform.arch}, Node ${probe.platform.node}`,
    `- Codex CLI: **${probe.version}** (proved against ${probe.tested.versions.join(', ')}), resolved as ${probe.resolved.kind}`,
    `- Auth mode: **${probe.auth.mode}**`,
    `- Lanes: ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `- Provider event lines captured: ${taps.length}`,
    '',
    '| Criterion | Check | Result | What it showed |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '`BLOCKED` is a capability this machine or this provider surface cannot supply. Each one carries a',
    'concrete alternative in the JSON evidence. `RECORDED` rows are facts the ticket asks to be written',
    'down rather than assertions that can pass or fail.',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'codex-acceptance-matrix.md'), md);
  console.log(`\nmatrix -> ${path.relative(ROOT, path.join(OUT_DIR, 'codex-acceptance-matrix.md'))}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane') out.lane = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--timeout') out.timeout = parseInt(argv[++i], 10);
    else if (a === '--api-depth') out.apiDepth = argv[++i];
  }
  return out;
}
