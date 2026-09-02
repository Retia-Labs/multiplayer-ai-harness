/*
 * Browser end-to-end multiplayer test. Starts a hub + a runtime (demo provider) in-process,
 * opens two Chromium contexts (Alice, Bob) against the web UI, and verifies the demo:
 * Alice's agent hits an approval wall → Bob sees it live and approves → both watch the
 * command run and the turn complete; Bob steers a running turn; presence; Changes panel.
 * Run: xvfb-run -a node test/e2e-multiplayer.js   (or headless without xvfb)
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');

function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓ ' + m); }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  const project = path.join(tmp, 'webapp');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'bundle.js'), '// built\n');
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("hi")\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: '/bin/bash' });

  const hub = new Hub({ dbFile: ':memory:', staticDir: path.join(__dirname, '..', 'apps', 'web'), log: () => {} });
  const addr = await hub.listen(0);
  const http = `http://127.0.0.1:${addr.port}`;
  const rt = new Runtime({ hubUrl: http.replace('http', 'ws'), userName: 'alice', dataDir: path.join(tmp, 'rt'), projects: [project], name: 'alice@laptop', log: () => {} });
  await rt.start();

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const shots = path.join(__dirname, '..', 'docs', 'harness');
  fs.mkdirSync(shots, { recursive: true });
  const ctxA = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const ctxB = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();

  // ---- login ----
  await alice.goto(http + '/');
  await alice.fill('#login-name', 'alice');
  await alice.click('#login-form button');
  await alice.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  assert((await alice.textContent('#me')).includes('alice'), 'alice joined the org');
  await bob.goto(http + '/?name=bob');
  await bob.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  assert(true, 'bob joined via ?name= (deep link)');

  // ---- fleet ----
  await alice.waitForSelector('.runtime-card', { timeout: 10000 });
  const card = await alice.textContent('.runtime-card');
  assert(card.includes('alice@laptop') && card.includes('webapp'), 'fleet shows the runtime and its project');
  assert((await alice.$$eval('.rc-tag.on', (n) => n.map((x) => x.textContent))).includes('demo'), 'runtime advertises the demo provider as configured');
  await alice.screenshot({ path: path.join(shots, 'fleet.png') });

  // ---- alice starts a risky turn ----
  await alice.fill('#input', 'Delete the build directory');
  await alice.press('#input', 'Enter');
  await alice.waitForSelector('#thread-view:not(.hidden)', { timeout: 10000 });
  await alice.waitForSelector('.approval-card', { timeout: 20000 });
  assert((await alice.textContent('.approval-cmd')).includes('rm -rf build'), 'alice sees the approval request for rm -rf build');
  assert((await alice.textContent('#working-label')).includes('approval'), 'working indicator says waiting for approval');

  // ---- bob sees it on the fleet, opens the thread, sees presence + the same card ----
  await bob.waitForSelector('.attention-item', { timeout: 10000 });
  assert((await bob.textContent('.attention-item .ai-cmd')).includes('rm -rf build'), 'bob\'s fleet "Needs attention" lists the pending approval');
  await bob.waitForSelector('.thread-item .t-dot', { timeout: 5000 });
  assert(true, 'bob\'s sidebar shows the amber approval dot on alice\'s thread');
  await bob.click('.attention-item .mini-btn:has-text("Open")');
  await bob.waitForSelector('.approval-card', { timeout: 10000 });
  await bob.waitForFunction(() => document.querySelectorAll('#presence .avatar').length === 2, null, { timeout: 10000 });
  await alice.waitForFunction(() => document.querySelectorAll('#presence .avatar').length === 2, null, { timeout: 10000 });
  assert(true, 'both see two viewers in presence');
  const cards = await bob.$$eval('.cmd-card, .plan-card, .reasoning', (n) => n.length);
  assert(cards >= 2, 'bob replayed the thread so far (reasoning + plan present)');
  await bob.screenshot({ path: path.join(shots, 'bob-approval.png') });

  // ---- bob approves from his window ----
  await bob.click('.approval-card button[data-decision="accept"]');
  await alice.waitForSelector('.resolved-chip', { timeout: 10000 });
  assert((await alice.textContent('.resolved-chip')).includes('bob approved'), 'alice sees "bob approved" in her thread');
  await alice.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  assert(!fs.existsSync(path.join(project, 'build')), 'the approved command really ran on alice\'s runtime (build/ deleted)');
  const cmdDone = await alice.$$eval('.cmd-card .cmd-status.completed', (n) => n.length);
  assert(cmdDone >= 2, 'command cards completed on alice\'s screen');
  await bob.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  const bobDone = await bob.$$eval('.plan-step.completed', (n) => n.length);
  assert(bobDone === 3, 'bob\'s plan card shows all steps completed (identical stream)');
  await alice.screenshot({ path: path.join(shots, 'alice-thread.png') });

  // ---- bob steers alice's next turn while it runs ----
  await alice.fill('#input', 'Tell me a joke about the repo');
  await alice.press('#input', 'Enter');
  await bob.waitForFunction(() => !document.querySelector('#working').classList.contains('hidden'), null, { timeout: 10000 });
  assert(await bob.$eval('#btn-send', (b) => b.classList.contains('steer')), 'bob\'s send button switches to steer mode while the turn runs');
  await bob.fill('#input', 'make it about crabs');
  await bob.press('#input', 'Enter');
  await alice.waitForSelector('.msg-user.steer', { timeout: 10000 });
  assert((await alice.textContent('.msg-user.steer .by')).includes('bob'), 'alice sees bob\'s steer attributed to him');
  await alice.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  const lastMsg = await alice.$$eval('.msg-assistant', (n) => n[n.length - 1].textContent);
  assert(lastMsg.includes('crabs'), 'agent acknowledged the steer in its reply');

  // ---- late joiner replays ----
  const ctxC = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const carol = await ctxC.newPage();
  await carol.goto(http + '/?name=carol');
  await carol.waitForSelector('.thread-item', { timeout: 10000 });
  await carol.click('.thread-item');
  await carol.waitForSelector('.resolved-chip', { timeout: 10000 });
  assert((await carol.$$eval('.msg-user', (n) => n.length)) >= 3, 'carol (late joiner) sees the full history including steer');
  await carol.waitForFunction(() => document.querySelectorAll('#presence .avatar').length === 3, null, { timeout: 10000 });
  assert(true, 'presence shows three viewers');

  // ---- changes panel via runtime ----
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("changed")\n');
  await alice.click('#btn-changes');
  await alice.waitForSelector('.dfl-item', { timeout: 10000 });
  const paths = await alice.$$eval('.dfl-item .dfl-path', (n) => n.map((x) => x.textContent.trim()));
  assert(paths.includes('index.js') && paths.includes('build/bundle.js'), 'Changes panel lists the modified and deleted files from the runtime');
  await alice.screenshot({ path: path.join(shots, 'changes.png') });
  await alice.fill('#commit-msg', 'chore: cleanup build');
  await alice.click('#btn-commit');
  await alice.waitForSelector('.diff-empty', { timeout: 10000 });
  assert(execSync('git log --oneline -1', { cwd: project }).toString().includes('chore: cleanup build'), 'commit from the UI landed in git on the runtime');

  // ---- worktree thread ----
  await alice.click('#btn-close-diff');
  await alice.click('#btn-new-thread');
  await alice.check('#fleet-worktree');
  await alice.fill('#input', 'Explore the repo');
  await alice.press('#input', 'Enter');
  await alice.waitForSelector('#topbar-worktree:not(.hidden)', { timeout: 10000 });
  const branch = (await alice.textContent('#topbar-branch')).trim();
  assert(branch.startsWith('codex/'), 'worktree thread runs on its own branch (' + branch + ')');
  await alice.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });

  await browser.close();
  rt.stop(); await hub.close();
  console.log('\nmultiplayer e2e passed ✅');
  process.exit(0);
})().catch((e) => { console.error('\nE2E FAILED:', e); process.exit(1); });
