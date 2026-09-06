/*
 * Browser end-to-end multiplayer test. Starts a hub + a runtime (demo provider) in-process,
 * opens two Chromium contexts (Alice, Bob) against the web UI, and verifies the demo:
 * Alice's agent hits an approval wall → Bob sees it live and approves → both watch the
 * command run and the turn complete; Bob steers a running turn; presence; Changes panel.
 * Run: xvfb-run -a node test/e2e-multiplayer.js   (or headless without xvfb)
 */
const { chromium } = require('playwright-core');
const { localShell } = require('../packages/runtime/executors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const { Hub } = require('../packages/hub/server');
const { Runtime } = require('../packages/runtime/index');
const { TeamOps } = require('../packages/protocol');

function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓ ' + m); }

async function captureEvidence(page, file, viewport) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { const toasts = document.querySelector('#toasts'); if (toasts) toasts.innerHTML = ''; });
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: 1360, height: 860 });
}

function ownerOp(url, token, makeMessage, expectedType) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = 'setup_' + Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => finish(new Error('owner setup operation timed out')), 10000);
    const finish = (error, message) => {
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error); else resolve(message);
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.on('error', finish);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') return ws.send(JSON.stringify({ ...makeMessage(message), id }));
      if (message.ref !== id) return;
      if (message.type === 'error') return finish(new Error(message.code || message.message));
      if (message.type === expectedType) finish(null, message);
    });
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  const project = path.join(tmp, 'webapp');
  fs.mkdirSync(path.join(project, 'build'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build', 'bundle.js'), '// built\n');
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("hi")\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project, shell: localShell().bin });

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
  await alice.waitForSelector('#team-gate:not(.hidden)', { timeout: 10000 });
  await alice.fill('#team-name', 'Retia');
  await alice.click('#btn-create-team');
  await alice.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  assert((await alice.textContent('#me')).includes('alice · Retia'), 'alice created and entered the private team');

  await alice.fill('#pair-code', rt.pairingCode);
  await alice.click('#btn-pair-host');
  await alice.waitForSelector('.runtime-card', { timeout: 10000 });

  await bob.goto(http + '/?name=bob');
  await bob.waitForSelector('#team-gate:not(.hidden)', { timeout: 10000 });
  const bobAccountId = await bob.inputValue('#team-gate-account-id');
  assert(bobAccountId.startsWith('u_'), 'bob can share his stable account ID before joining a team');
  await alice.fill('#invitee-user-id', bobAccountId);
  await alice.click('#btn-invite');
  await alice.waitForFunction(() => document.querySelector('#invite-code').value.length > 0, null, { timeout: 10000 });
  const bobInvite = await alice.inputValue('#invite-code');

  await bob.fill('#join-code', bobInvite);
  await bob.click('#btn-join-team');
  await bob.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  assert((await bob.textContent('#me')).includes('bob · Retia'), 'bob accepted alice\'s invitation');

  const aliceToken = await alice.evaluate(() => JSON.parse(localStorage.getItem('harness.session')).token);
  const wsUrl = http.replace('http', 'ws');
  const members = await ownerOp(wsUrl, aliceToken,
    ({ teamId }) => ({ type: TeamOps.TEAM_MEMBERS, teamId }), 'users');
  const bobMember = members.users.find((member) => member.name === 'bob');
  if (!bobMember) throw new Error('bob was not present in alice\'s team');
  await ownerOp(wsUrl, aliceToken,
    ({ teamId }) => ({ type: TeamOps.APPROVER_GRANT, teamId, userId: bobMember.userId }), 'ok');
  assert(true, 'alice delegated approval authority to bob');

  // ---- owner removes a disposable member through the team UI ----
  const ctxDisposable = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const disposable = await ctxDisposable.newPage();
  await disposable.goto(http + '/?name=disposable');
  await disposable.waitForSelector('#team-gate:not(.hidden)', { timeout: 10000 });
  const disposableAccountId = await disposable.inputValue('#team-gate-account-id');
  const disposableInvite = await ownerOp(wsUrl, aliceToken,
    ({ teamId }) => ({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: disposableAccountId }), 'invitation');
  await disposable.fill('#join-code', disposableInvite.invitation.code);
  await disposable.click('#btn-join-team');
  await disposable.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await alice.waitForSelector('#team-members [data-member-id="' + disposableAccountId + '"]', { timeout: 10000 });
  await bob.waitForSelector('#team-members [data-member-id="' + disposableAccountId + '"]', { timeout: 10000 });
  const memberStates = await alice.$$eval('#team-members [data-member-id]', (rows) => rows.map((row) => row.textContent));
  assert(memberStates.some((text) => text.includes('owner · endpoint access pending')) && memberStates.some((text) => text.includes('disposable') && text.includes('member · endpoint access pending')),
    'team member rows distinguish administration roles from endpoint access state');
  assert((await alice.$$eval('#team-members [data-action="remove-member"]', (buttons) => buttons.map((button) => button.dataset.userId))).includes(disposableAccountId),
    'team owner sees a Remove control for a teammate');
  assert((await bob.$$('#team-members [data-action="remove-member"]')).length === 0,
    'team members see the member list without removal controls');
  assert(await bob.isDisabled('#btn-invite') && await bob.isDisabled('#btn-pair-host') && (await bob.textContent('#team-admin-notice')).includes('Only the team owner'),
    'invite and host-pairing controls explain their owner-only boundary');
  alice.once('dialog', (dialog) => dialog.accept());
  await alice.click('#team-members button[data-user-id="' + disposableAccountId + '"]');
  await disposable.waitForSelector('#team-gate:not(.hidden)', { timeout: 10000 });
  await alice.waitForFunction((userId) => !document.querySelector('#team-members [data-member-id="' + userId + '"]'), disposableAccountId, { timeout: 10000 });
  assert((await alice.textContent('#team-members')).includes('bob') && !(await alice.textContent('#team-members')).includes('disposable'),
    'removal updates the owner member list and leaves bob in the team');
  await ctxDisposable.close();

  // ---- fleet ----
  await alice.waitForSelector('.runtime-card', { timeout: 10000 });
  const card = await alice.textContent('.runtime-card');
  assert(card.includes('alice@laptop') && card.includes('webapp'), 'fleet shows the runtime and its project');
  assert((await alice.$$eval('.rc-tag.on', (n) => n.map((x) => x.textContent))).includes('demo'), 'runtime advertises the demo provider as configured');
  const presets = await alice.$$eval('#preset-select option', (options) => options.map((option) => option.value));
  assert(JSON.stringify(presets) === JSON.stringify(['read-only', 'agent-untrusted', 'agent']) && await alice.inputValue('#preset-select') === 'agent',
    'composer offers only host-permitted presets and selects the host default');
  await alice.evaluate(() => {
    document.querySelector('#invite-code').value = 'inv_targeted_bob';
    document.querySelector('#invite-expiry').textContent = 'For bob · expires in 60 min. One use.';
  });
  await captureEvidence(alice, path.join(shots, 'fleet.png'), { width: 1487, height: 1058 });

  // ---- alice starts a risky turn ----
  await alice.fill('#input', 'Delete the build directory');
  await alice.press('#input', 'Enter');
  await alice.waitForSelector('#thread-view:not(.hidden)', { timeout: 10000 });
  await alice.waitForSelector('.approval-card', { timeout: 20000 });
  assert((await alice.textContent('.approval-cmd')).includes('rm -rf build'), 'alice sees the approval request for rm -rf build');
  assert((await alice.textContent('#working-label')).includes('approval'), 'working indicator says waiting for approval');
  assert((await alice.$$('.approval-card button')).length === 0 && (await alice.textContent('.approval-actions')).includes('delegated approval authority'),
    'team ownership alone does not show approval actions');

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
  const approvalContext = await bob.textContent('.approval-card');
  assert(approvalContext.includes('Requested by alice at') && approvalContext.includes('workspace webapp') && approvalContext.includes('host alice@laptop') && approvalContext.includes('provider demo') && approvalContext.includes('Inspect request evidence'),
    'approval card names its requester, time, workspace, host, provider, and inspectable evidence');
  const approvalDecisions = await bob.$$eval('.approval-card button[data-decision]', (buttons) => buttons.map((button) => button.dataset.decision).sort());
  assert(JSON.stringify(approvalDecisions) === JSON.stringify(['accept', 'cancel', 'decline']), 'delegated approver sees only decisions supported for this action');
  await captureEvidence(bob, path.join(shots, 'bob-approval.png'), { width: 1487, height: 1058 });

  // ---- bob approves from his window ----
  await bob.click('.approval-card button[data-decision="accept"]');
  await alice.waitForSelector('.resolved-chip', { timeout: 10000 });
  assert((await alice.textContent('.resolved-chip')).includes('bob approved · resolved at'), 'alice sees bob’s settled approval receipt and time');
  await alice.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  assert(!fs.existsSync(path.join(project, 'build')), 'the approved command really ran on alice\'s runtime (build/ deleted)');
  const cmdDone = await alice.$$eval('.cmd-card .cmd-status.completed', (n) => n.length);
  assert(cmdDone >= 2, 'command cards completed on alice\'s screen');
  await bob.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  const bobDone = await bob.$$eval('.plan-step.completed', (n) => n.length);
  assert(bobDone === 3, 'bob\'s plan card shows all steps completed (identical stream)');
  await alice.screenshot({ path: path.join(shots, 'alice-thread.png') });

  // ---- bob steers alice's next turn while it runs ----
  await alice.fill('#input', 'Tell me a joke');
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
  await carol.waitForSelector('#team-gate:not(.hidden)', { timeout: 10000 });
  const carolAccountId = await carol.inputValue('#team-gate-account-id');
  const carolInvite = await ownerOp(wsUrl, aliceToken,
    ({ teamId }) => ({ type: TeamOps.INVITE_CREATE, teamId, inviteeUserId: carolAccountId }), 'invitation');
  await carol.fill('#join-code', carolInvite.invitation.code);
  await carol.click('#btn-join-team');
  await carol.waitForSelector('.thread-item', { timeout: 10000 });
  await carol.click('.thread-item');
  await carol.waitForSelector('.resolved-chip', { timeout: 10000 });
  assert((await carol.$$eval('.msg-user', (n) => n.length)) >= 3, 'carol (late joiner) sees the full history including steer');
  await carol.waitForFunction(() => document.querySelectorAll('#presence .avatar').length === 3, null, { timeout: 10000 });
  assert(true, 'presence shows three viewers');

  // ---- team activity + collision radar + handoff ----
  await alice.click('#btn-new-thread');
  await alice.fill('#input', 'Create a NOTES.md summarizing this repo');
  await alice.press('#input', 'Enter');
  await alice.waitForSelector('.edit-card', { timeout: 20000 });
  await alice.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  await bob.click('#btn-new-thread');
  await bob.waitForFunction(() => [...document.querySelectorAll('.activity-row .ar-files')].some((n) => n.textContent.includes('NOTES.md')), null, { timeout: 10000 });
  assert(true, 'bob\'s fleet Team activity shows alice\'s agent touched NOTES.md');
  await bob.screenshot({ path: path.join(shots, 'team-activity.png') });
  await bob.fill('#input', 'Create a NOTES.md for onboarding');
  await bob.press('#input', 'Enter');
  await bob.waitForSelector('.approval-card.collision', { timeout: 20000 });
  assert((await bob.textContent('.approval-card.collision .approval-title')).includes('Collision'), 'bob\'s agent is stopped by a collision approval before overwriting alice\'s file');
  assert((await bob.textContent('.approval-card.collision')).includes("alice's thread"), 'collision reason names alice\'s thread');
  await bob.screenshot({ path: path.join(shots, 'collision.png') });
  await bob.click('.approval-card.collision button[data-decision="decline"]');
  await bob.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), null, { timeout: 30000 });
  assert((await bob.$$eval('.edit-badge', (n) => n.map((x) => x.textContent))).includes('declined'), 'declined write shows as declined; alice\'s NOTES.md untouched');
  assert(fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8').includes('summarizing this repo'), 'file content is still alice\'s');
  // handoff: alice hands her NOTES thread to bob
  await alice.click('#btn-assign');
  await alice.waitForSelector('#assign-modal:not(.hidden)');
  await alice.waitForFunction(() => [...document.querySelectorAll('#assign-user option')].some((o) => o.textContent === 'bob'), null, { timeout: 5000 });
  await alice.selectOption('#assign-user', { label: 'bob' });
  await alice.fill('#assign-note', 'please review the wording');
  await alice.click('#btn-do-assign');
  await bob.waitForFunction(() => [...document.querySelectorAll('.thread-item .t-sub')].some((n) => n.textContent.includes('assigned to you')), null, { timeout: 10000 });
  assert(true, 'bob sees the thread assigned to him in his sidebar');
  await alice.waitForSelector('.handoff-note', { timeout: 10000 });
  assert((await alice.textContent('.handoff-note')).includes('please review the wording'), 'handoff recorded as an attributed event with the note');
  assert(await alice.isVisible('#btn-audit'), 'audit export available on the thread');

  await browser.close();
  rt.stop(); await hub.close();
  console.log('\nmultiplayer e2e passed ✅');
  process.exit(0);
})().catch((e) => { console.error('\nE2E FAILED:', e); process.exit(1); });
