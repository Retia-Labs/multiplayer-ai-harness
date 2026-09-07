'use strict';
// Issue #9's first criterion, in the actual product: a teammate opens a running task in the
// app and sees objective, host, plan, changes, decisions and what it is blocked on.
//
// Every other test of the catch-up view renders a projection built in Node from events a
// test wrote. This one has a browser hold its own encrypted endpoint, take delivery of a key
// it was never given in the clear, decrypt a log a real host wrote from a real turn, and put
// the result on screen. If any part of that were still a fixture the screen here would be
// empty, which is exactly what makes it worth running.
//
// The task under test is deliberately parked on an approval nobody has answered yet, because
// "what is this blocked on" is the question a joining teammate actually has.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { TurnSession } = require('../packages/runtime/session');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { TeamOps, Events, ApprovalDecision } = require('../packages/protocol');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { sendTaskControl } = require('../packages/e2ee/task-control.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');

const root = path.join(__dirname, '..');
const out = path.join(root, '.artifacts', 'catchup-encrypted');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-catchup-e2ee-'));
const DESKTOP = { width: 1487, height: 1058 };

const checks = [];
const pass = (name, detail) => { checks.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
const waitFor = async (fn, label = '') => {
  for (let n = 0; n < 400; n++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
};
let hub, runtime, encrypted, browser, socket, running;

(async () => {
  fs.mkdirSync(out, { recursive: true });

  // ---- a hub serving the real app, the crypto SDK and the shared modules ----
  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), staticDir: path.join(root, 'apps/web'), log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;

  const project = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'out.txt'), 'built');

  runtime = new Runtime({
    hubUrl: url.replace('http', 'ws'), userName: 'host',
    dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true
  });
  await runtime.start();

  // ---- an account and a team, paired to that host ----
  let welcome; const messages = [];
  socket = new WebSocket(url.replace('http', 'ws'));
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', role: 'client', name: 'alex' }));
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); messages.push(m); if (m.type === 'welcome') welcome = m; };
  await waitFor(() => welcome && hub.pendingPairings.size, 'welcome');
  socket.send(JSON.stringify({ type: TeamOps.TEAM_CREATE, name: 'Checkout team', id: 'op1' }));
  await waitFor(() => messages.some((m) => m.type === 'team'), 'team');
  const team = messages.find((m) => m.type === 'team').team;
  socket.send(JSON.stringify({ type: TeamOps.RUNTIME_PAIR, teamId: team.id, code: runtime.pairingCode, id: 'op2' }));
  await waitFor(() => runtime.teamId === team.id, 'paired');
  const account = hub.store.userById(welcome.user.id);

  const projectId = 'ep_' + '9'.repeat(32);
  encrypted = new EncryptedHost({
    runtime, url, statePath: path.join(tmp, 'outbox.sqlite'),
    projects: new Map([[projectId, project]]), log: () => {}
  });
  const hostIdentity = await encrypted.start();

  // ---- the browser, holding its own endpoint ----
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: DESKTOP, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => console.log('  page error: ' + error.message));
  await page.goto(url);
  // Sign in as the account that was just created, the way a returning app does.
  await page.evaluate((session) => localStorage.setItem('harness.session', JSON.stringify(session)),
    { token: account.token, name: account.name });
  await page.reload();

  // The app opens its endpoint on entering a team, and the first endpoint in a team is
  // bootstrapped by its owner - there is nobody else to vouch for it yet.
  await page.waitForFunction(() => window.__plexus && window.__plexus.state.encryptedState, null, { timeout: 30000 });
  const enrolment = await page.evaluate(() => window.__plexus.state.encryptedState);
  assert.equal(enrolment.state, 'verified', 'the owner bootstraps the first endpoint: ' + JSON.stringify(enrolment));
  assert.equal(enrolment.durable, true, 'the browser holds a persistent key store');
  pass('the app opens a persistent encrypted endpoint in the browser and enrols it', enrolment.device + ' · verified');

  const identity = await page.evaluate(() => window.__plexus.state.encryptedIdentity);
  const listed = hub.store.db.prepare('SELECT user_id, device_id FROM e2ee_devices').all();
  assert.ok(listed.some((row) => row.device_id === identity.device), 'the browser published its keys through the hub');
  pass('its public keys reach the hub, and only the public ones', listed.length + ' devices in the directory');

  // ---- it confirms the host, then starts a task on it ----
  const confirmed = await page.evaluate(async (runtimeId) => {
    const client = window.__plexus.state.encrypted;
    const endpoints = await client.hostEndpoints(runtimeId);
    if (!endpoints.length) return { endpoints };
    await client.confirmHost(runtimeId, endpoints[0]);
    return { endpoints, confirmed: client.confirmedHost(runtimeId) };
  }, runtime.id);
  assert.equal(confirmed.endpoints.length, 1);
  assert.equal(confirmed.endpoints[0].ed25519, hostIdentity.ed25519, 'the fingerprint offered is the host\'s own');
  assert.equal(confirmed.confirmed.device, hostIdentity.device);
  pass('the host\'s fingerprint is shown for comparison and confirmed by a person', confirmed.endpoints[0].fingerprint.slice(0, 24) + '…');

  const task = await page.evaluate(async ({ runtimeId, projectId }) => {
    return window.__plexus.state.encrypted.createTask(runtimeId, projectId,
      { title: 'Clear the build directory', objective: 'delete the build directory' });
  }, { runtimeId: runtime.id, projectId });
  assert.match(task.id, /^et_[a-f0-9]{32}$/);
  pass('the browser starts an encrypted task on the confirmed host', task.id);

  // ---- the host runs it, and parks on an approval nobody has answered ----
  let session, requested = null;
  const approvalTurn = async (emit, decrypted) => {
    session = new TurnSession({
      thread: { id: task.id, cwd: project, settings: {} },
      by: { userId: account.id, name: 'alex' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider: { id: 'demo' },
      settings: { approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], log: () => {},
      emit: (event) => { emit(event); if (event.method === Events.COMMAND_REQUEST_APPROVAL) requested = event; }
    });
    await session.run();
    return session;
  };
  // Not awaited: the turn stays parked on the approval, which is the state under test.
  running = encrypted.run(task, { runTurn: approvalTurn, provider: 'demo' });
  await waitFor(() => requested, 'the turn asks for an approval');
  await waitFor(() => hub.store.db.prepare('SELECT COUNT(*) AS n FROM encrypted_task_events WHERE task_id=?').get(task.id).n >= 4,
    'the request reaches the relay');

  // ---- and a teammate opens the catch-up screen ----
  await page.evaluate(() => window.__plexus.refreshEncrypted());
  // The catch-up button lives inside a thread view; this opens the same screen it opens.
  await page.evaluate(() => window.__plexus.openCatchup());
  await page.waitForSelector('#catchup-view .cu-approval', { timeout: 30000 });

  const shown = await page.evaluate(() => {
    const text = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => n.textContent.trim());
    return {
      objective: text('#catchup-view .cu-objective')[0] || null,
      facts: text('#catchup-view .cu-fact'),
      plan: text('#catchup-view .cu-plan li'),
      changes: text('#catchup-view .cu-file-path'),
      decisions: text('#catchup-view .cu-card-text'),
      approvals: text('#catchup-view .cu-approval-action'),
      blocker: text('#catchup-view .cu-blocker')[0] || null,
      freshness: document.querySelector('#catchup-view').getAttribute('data-freshness'),
      sources: document.querySelectorAll('#catchup-view .cu-source').length
    };
  });
  assert.equal(shown.objective, 'delete the build directory');
  assert.ok(shown.plan.some((step) => /rm -rf build/.test(step)), 'the plan is on screen: ' + JSON.stringify(shown.plan));
  assert.ok(shown.approvals.some((a) => /rm -rf build/.test(a)), 'the outstanding approval is on screen');
  assert.match(shown.blocker, /rm -rf build/);
  pass('the screen shows the objective, plan and what the task is blocked on, decrypted in the browser',
    shown.approvals[0]);
  assert.ok(shown.sources > 0, 'every claim carries a source link');
  pass('each claim on screen carries a source the reader can open', shown.sources + ' source links');

  // Criterion 1 names responsible, execution host and provider as things the screen shows.
  // Two of the three are known here; the provider is not recorded anywhere, and the screen
  // saying so is the correct outcome rather than a name nobody wrote down.
  const facts = shown.facts.join(' | ');
  assert.match(facts, /Responsible/);
  assert.match(facts, new RegExp('Execution host'));
  assert.ok(facts.includes(runtime.id), 'the host is named: ' + facts);
  assert.match(facts, /Provider/);
  assert.ok(facts.includes('demo'), 'the provider the host ran is named on screen: ' + facts);
  // Status is the fourth fact, and while the task is parked it is read off the log rather
  // than stated by it - there is no completion event yet, so claiming "Recorded" would be
  // this screen asserting something nobody wrote.
  // The task is open and no turn has finished, and the screen says both rather than letting
  // a running agent stand in for unfinished work.
  assert.match(facts, /Status.*open/);
  assert.ok(facts.includes('Read from the log'), 'an unsettled status is marked as derived: ' + facts);
  pass('responsible, execution host, provider and status are each named on screen', shown.facts.length + ' facts');

  await page.screenshot({ path: path.join(out, 'blocked-on-approval-1487.png') });

  // Nothing the relay holds explains any of it.
  const relayHeld = JSON.stringify(hub.store.db.prepare('SELECT * FROM encrypted_task_events WHERE task_id=?').all(task.id));
  assert.equal(relayHeld.includes('rm -rf build'), false, 'the relay does not hold the action it is being asked to approve');
  pass('the relay holds none of what the screen just showed', 'ciphertext only');

  // ---- the ceremony is not skippable: forget the host and the screen stops reading ----
  await page.evaluate((runtimeId) => localStorage.removeItem('plexus.host.' + runtimeId), runtime.id);
  await page.evaluate(() => window.__plexus.openCatchup());
  await page.waitForSelector('#catchup-view aside[aria-label="Confirm the execution host"]', { timeout: 30000 });
  const prompt = await page.evaluate(() => ({
    approvals: document.querySelectorAll('#catchup-view .cu-approval').length,
    objective: document.querySelectorAll('#catchup-view .cu-objective').length,
    asks: !!document.querySelector('#catchup-view aside[aria-label="Confirm the execution host"]')
  }));
  assert.equal(prompt.asks, true);
  assert.equal(prompt.approvals, 0, 'nothing from the task is shown to an endpoint that has confirmed nobody');
  assert.equal(prompt.objective, 0);
  pass('an endpoint that has confirmed no host is shown the ceremony, not the task', 'no content leaks past it');
  await page.screenshot({ path: path.join(out, 'host-unconfirmed-1487.png') });

  // And clicking through it restores exactly what was there before.
  await page.click('#catchup-view button[data-action="confirm-host"]');
  await page.waitForSelector('#catchup-view .cu-approval', { timeout: 30000 });
  pass('confirming the host through the screen restores the projection', 'the same task, read again');

  // ---- somebody answers, and the same screen stops asking ----
  session.resolveApproval(requested.requestId, ApprovalDecision.ACCEPT, { userId: account.id, name: 'alex' },
    { turnId: session.turnId, fingerprint: requested.fingerprint });
  await running;
  await page.evaluate(() => window.__plexus.openCatchup());
  await page.waitForFunction(() => document.querySelectorAll('#catchup-view .cu-approval').length === 0, null, { timeout: 30000 });
  const answered = await page.evaluate(() => ({
    decisions: Array.from(document.querySelectorAll('#catchup-view .cu-card-text')).map((n) => n.textContent.trim()),
    by: Array.from(document.querySelectorAll('#catchup-view .cu-card-by')).map((n) => n.textContent.trim())
  }));
  assert.ok(answered.decisions.some((d) => /Approval accept/.test(d)), 'the decision is on screen: ' + JSON.stringify(answered));
  assert.ok(answered.by.some((b) => /alex/.test(b)), 'attributed to whoever made it');
  pass('once answered, the screen shows the recorded decision instead of the request', answered.decisions.join(' / '));
  await page.screenshot({ path: path.join(out, 'approval-answered-1487.png') });

  // ---- and one that changes a file, so the last two things criterion 1 names are shown ----
  //
  // The first task is blocked on a destructive command, so it records no file changes and
  // never completes - which is honest, and leaves "recent changes" and a recorded status
  // unproven. This one writes a file and finishes, so both are read from a real log.
  const writing = await page.evaluate(async ({ runtimeId, projectId }) =>
    window.__plexus.state.encrypted.createTask(runtimeId, projectId,
      { title: 'Write the release notes', objective: 'create NOTES.md describing the release' }),
  { runtimeId: runtime.id, projectId });

  const writeTurn = async (emit, decrypted) => {
    const turn = new TurnSession({
      thread: { id: writing.id, cwd: project, settings: {} },
      by: { userId: account.id, name: 'alex' },
      input: [{ type: 'text', text: decrypted.objective }],
      provider: { id: 'demo' },
      settings: { approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' },
      executor: runtime.executor, history: [], log: () => {}, emit
    });
    await turn.run();
    return turn;
  };
  await encrypted.run(writing, { runTurn: writeTurn, provider: 'demo' });

  await page.evaluate(() => window.__plexus.refreshEncrypted());
  // Opening a specific task is the mapping the app already uses: the thread it is looking at.
  await page.evaluate((id) => { window.__plexus.state.activeThreadId = id; window.__plexus.openCatchup(); }, writing.id);
  await page.waitForSelector('#catchup-view .cu-file-path', { timeout: 30000 });

  const finished = await page.evaluate(() => ({
    changes: Array.from(document.querySelectorAll('#catchup-view .cu-file-path')).map((n) => n.textContent.trim()),
    facts: Array.from(document.querySelectorAll('#catchup-view .cu-fact')).map((n) => n.textContent.trim()),
    approvals: document.querySelectorAll('#catchup-view .cu-approval').length,
    sources: document.querySelectorAll('#catchup-view .cu-source').length
  }));
  assert.ok(finished.changes.some((file) => /NOTES\.md/.test(file)),
    'the file the agent wrote is on screen: ' + JSON.stringify(finished.changes));
  pass('recent changes are read from the encrypted log and named on screen', finished.changes.join(', '));

  const finishedFacts = finished.facts.join(' | ');
  // The turn completed; the task is still open, because no person has closed it. The screen
  // carries both facts, which is exactly what #13's fourth criterion asks for.
  assert.match(finishedFacts, /Status.*open/);
  assert.match(finishedFacts, /Last turn.*completed/);
  assert.equal(finished.approvals, 0, 'a task nobody is waiting on shows no outstanding approval');
  pass('a finished turn is shown next to the task outcome, not instead of it', 'Status open · Last turn completed');
  await page.screenshot({ path: path.join(out, 'completed-with-changes-1487.png') });
  // ---- issue #12: a teammate's question, in the app's inbox ----
  //
  // The question is asked from a second endpoint entirely, so what the browser renders is a
  // record it decrypted rather than one it wrote. Nothing here is addressed to the asker.
  const dana = new WebSocket(url.replace('http', 'ws'));
  const danaMsgs = [];
  let danaWelcome;
  dana.onopen = () => dana.send(JSON.stringify({ type: 'hello', role: 'client', name: 'dana' }));
  dana.onmessage = ({ data }) => { const m = JSON.parse(data); danaMsgs.push(m); if (m.type === 'welcome') danaWelcome = m; };
  await waitFor(() => danaWelcome, 'dana connected');
  const invite = await new Promise((resolve) => {
    const id = 'op_invite';
    const onMsg = ({ data }) => { const m = JSON.parse(data); if (m.ref === id) { socket.removeEventListener('message', onMsg); resolve(m); } };
    socket.addEventListener('message', onMsg);
    socket.send(JSON.stringify({ type: TeamOps.INVITE_CREATE, teamId: team.id, inviteeUserId: danaWelcome.user.id, ttlMs: 60000, id }));
  });
  dana.send(JSON.stringify({ type: TeamOps.INVITE_ACCEPT, code: invite.invitation.code, id: 'op_join' }));
  await waitFor(() => danaMsgs.some((m) => m.type === 'team'), 'dana joined');
  const danaAccount = hub.store.userById(danaWelcome.user.id);

  const danaEndpoint = await Endpoint.create({
    user: matrixUser(danaAccount.id), device: 'DANADEV',
    transport: new HubKeyTransport({ url, token: danaAccount.token, device: 'DANADEV' })
  });
  await new EnrollmentTransport({ url, token: danaAccount.token }).announce(team.id, announcement(danaEndpoint));
  // The browser account is the team owner, so it is the one that confirms her - through the
  // same client that has been reading tasks all along.
  await page.evaluate(async (target) => window.__plexus.state.encrypted.confirmTeammate(target),
    { userId: danaAccount.id, ...announcement(danaEndpoint) });
  await new EnrollmentTransport({ url, token: account.token }).grant(team.id, projectId, danaAccount.id, 'participant');
  await encrypted.admitParticipants(writing);
  await danaEndpoint.confirmEndpoint(hostIdentity, { confirmed: true });
  await danaEndpoint.open(await danaEndpoint.transport.drain());

  const question = 'Should the release notes mention the retry change?';
  await sendTaskControl(danaEndpoint, hostIdentity, {
    task: writing, action: 'help.request',
    payload: { id: 'help_browsercheck01', question, recipient: account.id }
  });
  const gathered = await encrypted.collect();
  assert.equal(gathered.applied.length, 1, 'the host recorded the question: ' + JSON.stringify(gathered));

  await page.evaluate(() => window.__plexus.openInbox());
  await page.waitForSelector('#inbox-view .cu-help', { timeout: 30000 });
  const shownInbox = await page.evaluate(() => ({
    count: document.querySelector('#inbox-count').textContent,
    questions: Array.from(document.querySelectorAll('#inbox-view .cu-help-question')).map((n) => n.textContent.trim()),
    who: Array.from(document.querySelectorAll('#inbox-view .cu-help-who')).map((n) => n.textContent.trim())
  }));
  assert.deepEqual(shownInbox.questions, [question]);
  assert.equal(shownInbox.count, '1');
  assert.ok(shownInbox.who[0].includes('asked you'), shownInbox.who[0]);
  pass('a teammate\'s question is decrypted in the browser and shown in the inbox', shownInbox.questions[0]);
  await page.screenshot({ path: path.join(out, 'inbox-1487.png') });

  // Resolving goes back through the host, and the inbox clears only once the host has
  // recorded it - not because the button was pressed.
  await page.click('#inbox-view button[data-action="resolve-help"]');
  // The host picks control messages up when it next looks, so this looks repeatedly rather
  // than once - the same poll a running host performs, and the reason the inbox count is not
  // cleared optimistically in the first place.
  let settledBrowser = { applied: [] };
  for (let n = 0; n < 200 && !settledBrowser.applied.length; n++) {
    settledBrowser = await encrypted.collect();
    if (!settledBrowser.applied.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(settledBrowser.applied.length, 1, JSON.stringify(settledBrowser));
  await page.evaluate(() => window.__plexus.refreshEncrypted());
  await page.waitForFunction(() => document.querySelector('#inbox-count').textContent === '0', null, { timeout: 30000 });
  pass('resolving from the inbox is recorded by the host and clears the count', 'inbox back to 0');

  try { dana.close(); } catch {}
  try { danaEndpoint.close(); } catch {}

  fs.writeFileSync(path.join(out, 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), checks }, null, 2) + '\n');
  console.log('\n' + checks.length + ' encrypted catch-up checks passed');
})().then(async () => {
  socket?.close(); try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  await browser?.close?.(); await hub?.close?.(); process.exit(0);
}).catch(async (error) => {
  console.error('ENCRYPTED CATCH-UP FAILED\n', error);
  socket?.close(); try { encrypted?.close(); } catch {}
  try { runtime?.stop?.(); } catch {}
  try { await browser?.close?.(); } catch {}
  try { await hub?.close?.(); } catch {}
  process.exit(1);
});
