'use strict';
// Browser leg of issue #8: what happens to a teammate's enrolment when the browser is the
// endpoint, and what happens when its site data is gone.
//
// The interesting case is not the happy one. A browser profile that loses its IndexedDB has
// lost the private half of the identity that was vouched for, and the account, the token
// and the project grant all survive that loss untouched. If enrolment were a property of
// the account, the rebuilt profile would silently keep reading. It is a property of the
// keys, so it comes back pending and reads nothing until a human confirms it again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { ExperimentRelay } = require('../packages/e2ee/experiment-relay');
const { HttpKeyTransport } = require('../packages/e2ee/http-transport.mjs');
const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');
const { EncryptedTaskState, EncryptedFixtureHost, fixtureEvents, fixtureEventId } = require('../packages/runtime/encrypted-task');
const { EnrollmentTransport, announcement, confirmTeammateEndpoint, grantProjectAccess } = require('../packages/e2ee/enrollment.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-enrolment-browser-'));
const root = path.join(__dirname, '..');
const web = path.join(tmp, 'web');
const waitFor = async (fn) => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('fixture_timeout'); };
let hub, keyRelay, runtime, host, owner, browser, state, socket;
const checks = [];
const pass = (name, detail) => { checks.push({ name, status: 'pass' }); console.log('PASS ' + name + (detail ? ' - ' + detail : '')); };

(async () => {
  for (const name of ['packages/e2ee/endpoint-core.mjs', 'packages/e2ee/http-transport.mjs', 'packages/e2ee/task-log.mjs', 'packages/e2ee/enrollment.mjs', 'packages/protocol/encrypted-task.mjs']) {
    fs.mkdirSync(path.dirname(path.join(web, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(web, name));
  }
  fs.cpSync(path.join(root, 'node_modules/@matrix-org/matrix-sdk-crypto-wasm'), path.join(web, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/encrypted-task-client.html'), path.join(web, 'index.html'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/encrypted-task-client.mjs'), path.join(web, 'fixture.mjs'));

  hub = new Hub({ dbFile: path.join(tmp, 'relay.sqlite'), staticDir: web, log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;
  keyRelay = new ExperimentRelay(path.join(tmp, 'keys.sqlite'));
  await keyRelay.listen();

  // The owner runs the desktop endpoint; the teammate is the browser.
  const ownerAccount = hub.store.createAccount('owner');
  const mate = hub.store.createAccount('teammate');
  const team = hub.store.createTeam('fixture', ownerAccount.id);
  // The invitation path itself is #5's test; this one needs only the seat it produces.
  hub.store._stmts.upsertMember.run(team.id, mate.id, 'member', 'pending', Date.now());
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  runtime = new Runtime({ hubUrl: url.replace('http', 'ws'), userName: 'host', dataDir: path.join(tmp, 'runtime'), projects: [project], encryptedTasksOnly: true });
  await runtime.start();
  await waitFor(() => hub.pendingPairings.size);
  socket = new WebSocket(url.replace('http', 'ws'));
  let welcome = false;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: ownerAccount.token }));
  socket.onmessage = ({ data }) => { if (JSON.parse(data).type === 'welcome') welcome = true; };
  await waitFor(() => welcome);
  socket.send(JSON.stringify({ type: 'runtime/pair', teamId: team.id, code: runtime.pairingCode }));
  await waitFor(() => runtime.teamId === team.id);

  const ownerKeys = keyRelay.enroll(matrixUser(ownerAccount.id), 'OWNERDEV');
  host = await Endpoint.create({ user: matrixUser(runtime.id), device: 'HOST', transport: new HttpKeyTransport(keyRelay.enroll(matrixUser(runtime.id), 'HOST')) });
  owner = await Endpoint.create({ user: matrixUser(ownerAccount.id), device: 'OWNERDEV', transport: new HttpKeyTransport(ownerKeys) });
  await owner.confirmEndpoint(host.identity(), { confirmed: true });
  await host.confirmEndpoint(owner.identity(), { confirmed: true });
  const ownerEnroll = new EnrollmentTransport({ url, token: ownerAccount.token });
  await ownerEnroll.bootstrap(team.id, announcement(owner));

  // The owner creates the task and the host writes the whole log before the teammate exists
  // anywhere in this story - that is what makes the browser a late joiner.
  const secret = 'BROWSER_PRIVATE_' + randomBytes(16).toString('hex');
  const task = { version: 1, id: newId('et'), teamId: team.id, runtimeId: runtime.id, projectId: newId('ep'), creatorUserId: ownerAccount.id };
  const payload = { title: secret + ' title', objective: secret + ' objective', fixture: { plan: secret + ' plan', path: secret + '/file', result: secret + ' result', diff: secret + ' diff', activity: secret + ' activity', answer: secret + ' answer' } };
  const ownerTasks = new EncryptedTaskTransport({ url, token: ownerAccount.token });
  const created = await createEncryptedTask(owner, ownerTasks, { task, writer: host.identity(), payload });
  state = new EncryptedTaskState(path.join(tmp, 'outbox.sqlite'));
  const hostTasks = new EncryptedTaskTransport({ url, token: runtime.runtimeToken, runtimeId: runtime.id });
  const adapter = new EncryptedFixtureHost({ runtime, endpoint: host, transport: hostTasks, state, projects: new Map([[task.projectId, project]]), creators: new Map([[ownerAccount.id, owner.identity()]]) });
  const opened = await adapter.open(created.task);
  await owner.open(await owner.transport.drain());
  const events = fixtureEvents(opened.objective);
  for (let i = 0; i < events.length; i++) await opened.writer.append(events[i], fixtureEventId(task.id, i));

  const cfg = (storeKey, device) => ({
    endpoint: { user: matrixUser(mate.id), device, storeName: 'fixture', storeKey: [...storeKey], transport: keyRelay.enroll(matrixUser(mate.id), device) },
    token: mate.token, task, writer: host.identity()
  });
  const launch = async (profile, storeKey, device = 'BROWSER') => {
    browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
    const page = browser.pages()[0];
    await page.goto(url);
    await page.waitForFunction(() => globalThis.fixture);
    const identity = await page.evaluate((c) => fixture.init(c), cfg(storeKey, device));
    return { page, identity };
  };

  const firstKey = randomBytes(32);
  const profile = path.join(tmp, 'profile');
  let { page, identity } = await launch(profile, firstKey);

  const announced = await page.evaluate((t) => fixture.announce(t), team.id);
  assert.equal(announced.endpoint.state, 'pending');
  pass('a browser endpoint announces itself as pending', 'teammate/BROWSER');

  const blind = await page.evaluate(() => fixture.reconnect());
  assert.equal(blind.error, 'not_a_project_participant');
  pass('an account and a task id read nothing from the browser', blind.error);

  await confirmTeammateEndpoint(owner, ownerEnroll, team.id, { userId: mate.id, ...identity, device: 'BROWSER' }, { confirmed: true });
  const handoff = await grantProjectAccess(owner, ownerEnroll, { teamId: team.id, projectId: task.projectId, member: { userId: mate.id, device: 'BROWSER' }, taskIds: [task.id] });
  await page.evaluate((id) => fixture.confirm(id), owner.identity());
  await page.evaluate((id) => fixture.confirm(id), host.identity());
  const accepted = await page.evaluate((h) => fixture.accept(h), handoff);
  assert.ok(accepted.sessions.length > 0);
  const view = await page.evaluate(() => fixture.reconnect());
  assert.equal(view.seq, events.length);
  assert.deepEqual(view.events, events);
  assert.match(await page.textContent('#status'), /caught-up/);
  pass('the confirmed browser replays the whole history it was never present for', view.seq + ' events');

  // Persistence: the same profile, reopened, still holds the keys and the checkpoint.
  await page.evaluate(() => fixture.close());
  await browser.close(); browser = null;
  const reopened = await launch(profile, firstKey);
  page = reopened.page;
  assert.deepEqual(reopened.identity, identity);
  const persisted = await page.evaluate(() => fixture.reconnect());
  assert.equal(persisted.seq, events.length);
  pass('closing and reopening the browser keeps the enrolment and the history', 'same identity, ' + persisted.seq + ' events');

  // Site-data loss: the profile is gone, so IndexedDB is gone, so the private keys are gone.
  // The account, its token and the project grant are all untouched.
  await page.evaluate(() => fixture.close());
  await browser.close(); browser = null;
  fs.rmSync(profile, { recursive: true, force: true });
  const rebuilt = await launch(profile, randomBytes(32), 'BROWSER2');
  page = rebuilt.page;
  assert.notDeepEqual(rebuilt.identity, identity);
  const reannounced = await page.evaluate((t) => fixture.announce(t), team.id);
  assert.equal(reannounced.endpoint.state, 'pending');
  assert.equal(reannounced.known, false);
  pass('a browser that lost its site data comes back with new keys and a pending row', rebuilt.identity.curve25519.slice(0, 8) + '...');

  const afterWipe = await page.evaluate(() => fixture.reconnect());
  assert.equal(afterWipe.error, 'task_integrity_failed');
  pass('the rebuilt browser still holds the grant and still cannot read', afterWipe.error);

  await confirmTeammateEndpoint(owner, ownerEnroll, team.id, { userId: mate.id, ...rebuilt.identity, device: 'BROWSER2' }, { confirmed: true });
  const rehandoff = await grantProjectAccess(owner, ownerEnroll, { teamId: team.id, projectId: task.projectId, member: { userId: mate.id, device: 'BROWSER2' }, taskIds: [task.id] });
  await page.evaluate((id) => fixture.confirm(id), owner.identity());
  await page.evaluate((id) => fixture.confirm(id), host.identity());
  await page.evaluate((h) => fixture.accept(h), rehandoff);
  const recovered = await page.evaluate(() => fixture.reconnect());
  assert.equal(recovered.seq, events.length);
  assert.deepEqual(recovered.events, events);
  pass('re-enrolment restores the history to the rebuilt browser', recovered.seq + ' events');

  const dump = JSON.stringify({ events: await ownerTasks.page(task.id), keyRelay: keyRelay.evidence(), enrollment: await ownerEnroll.state(team.id, task.projectId) });
  assert.equal(dump.includes(secret), false);
  for (const file of ['relay.sqlite', 'relay.sqlite-wal', 'keys.sqlite', 'keys.sqlite-wal']) {
    const target = path.join(tmp, file);
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target).includes(Buffer.from(secret)), false);
  }
  pass('nothing the relay stores or serves contains the task text', secret.slice(0, 16) + '...');

  const out = path.join(root, '.artifacts', 'teammate-enrollment');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({
    ranAt: new Date().toISOString(), browser: await page.evaluate(() => navigator.userAgent), checks
  }, null, 2) + '\n');
  console.log('\n' + checks.length + ' browser enrolment checks passed');
})().catch((error) => { console.error('TEAMMATE ENROLLMENT BROWSER FAILED\n', error); process.exitCode = 1; })
  .finally(async () => {
    socket?.close();
    if (browser) await browser.close();
    runtime?.stop?.();
    host?.close();
    owner?.close();
    state?.close();
    if (hub) await hub.close();
    if (keyRelay) await keyRelay.close();
  });
