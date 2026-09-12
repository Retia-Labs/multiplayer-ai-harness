'use strict';
// Continuous optional extension of desktop-smoke. The app owns its installed runtime,
// durable broker and provider; the second person uses the hub's actual browser renderer.
// UI actions perform every enrollment/control mutation. __plexus reads only inspect
// accepted snapshots; no controller or cryptographic implementation is substituted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const removalPrompt = 'Remove cleanup using the provided host workspace removal tool. Wait for the one-action decision before continuing.';
const correctionPrompt = 'Correction: after the approved removal, read correction.txt and replace NOTES.md with exactly its bytes, including its final newline, using only the provided host workspace tools.';
const demoCorrectionPrompt = 'Create NOTES.md for Bob: reviewed correction.';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const snapshot = page => page.evaluate(() => {
  const state = window.__plexus.state;
  return { task: state.encryptedTasks.find(task => task.id === state.activeThreadId),
    value: state.encryptedSnapshots.get(state.activeThreadId), userId: state.me.id,
    identity: state.encryptedIdentity, durable: state.encryptedState?.durable };
});
const until = async (read, label, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out: ' + label);
};

module.exports = async function desktopCollaboration({ app, win, project, realCodex, url, assert, desktopErrors = [] }) {
  const out = path.join(__dirname, '..', '.artifacts', 'desktop-collaboration');
  fs.mkdirSync(out, { recursive: true });
  const mode = realCodex ? 'codex' : 'demo';
  const checks = [], errors = [], captures = [];
  const check = (condition, message) => { assert(condition, message); checks.push(message); };
  const capture = async (page, name) => {
    const file = mode + '-' + name + '.png'; await page.screenshot({ path: path.join(out, file) }); captures.push(file);
  };
  let browser, bob;
  try {
    const initial = await snapshot(win);
    const initialNotes = fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8');
    const correctedText = fs.readFileSync(path.join(project, 'correction.txt'), 'utf8');
    check(initial.durable === true && await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 1),
      'the desktop keeps its actual durable encrypted endpoint and hidden broker');
    check(initial.value.turn === 'completed' && !initial.value.outcome, 'provider completion leaves the shared task outcome open');
    const taskId = initial.task.id;
    const runtimeId = initial.task.runtimeId;
    browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' }),
      headless: true, args: ['--no-sandbox'] });
    bob = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await bob.emulateMedia({ reducedMotion: 'reduce' });
    bob.on('pageerror', error => errors.push(error.message));
    await bob.goto(url);
    await bob.locator('#login-name').fill('Bob'); await bob.locator('#login-form button').click();
    await bob.locator('#team-gate').waitFor({ state: 'visible' });
    const bobId = await bob.locator('#team-gate-account-id').inputValue();
    await win.locator('#nav-fleet').click();
    await win.locator('#invitee-user-id').fill(bobId); await win.locator('#btn-invite').click();
    await win.locator('#invite-row').waitFor({ state: 'visible' });
    await bob.locator('#join-code').fill(await win.locator('#invite-code').inputValue()); await bob.locator('#btn-join-team').click();
    await bob.locator('#enrollment-badge').waitFor({ state: 'visible' });
    await win.locator('#btn-access').click();
    const bobDevice = win.locator('#access-view .ew-device').filter({ hasText: 'Bob' });
    await bobDevice.locator('input[type="checkbox"]').check();
    await bobDevice.locator('[data-action="verify-teammate"]').click();
    await bobDevice.locator('[data-action="grant-project"]').click();
    await bob.locator('#encrypted-setup').filter({ hasText: 'This endpoint: verified' }).waitFor({ timeout: 45000 });
    // Device verification by the owner is not the recipient trusting the owner.
    // Follow the same explicit fingerprint ceremony as a browser-only teammate.
    await bob.locator('#btn-access').click();
    const authority = bob.locator('[data-action="confirm-team-authority"]');
    const ownerFingerprint = await win.evaluate(() => window.__plexus.state.encryptedIdentity.fingerprint);
    check((await authority.locator('..').innerText()).includes(ownerFingerprint),
      'Bob compares the displayed team authority with the desktop owner fingerprint');
    check(await bob.evaluate(() => window.__plexus.state.encryptedState.membershipIdentity === null),
      'relay device verification alone does not establish trusted membership for Bob');
    await authority.click();
    await bob.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click();
    await bob.locator('[data-action="verify-task-host"]').click();
    await bob.locator('[data-action="confirm-host"]').click();
    await bob.locator('.ew-file h4').filter({ hasText: 'NOTES.md' }).waitFor({ timeout: 45000 });
    check((await snapshot(bob)).task.runtimeId === runtimeId, 'late Bob receives the existing task history from the desktop execution host');
    await bob.locator('[data-action="view-catchup"]').click();
    await bob.locator('#ew-content .cu-objective').waitFor();
    await capture(bob, 'late-bob-catchup-desktop');
    await bob.locator('[data-action="view-review"]').click();
    await win.locator('.encrypted-task-row[data-task-id="' + taskId + '"]').click();
    await win.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor();
    await win.locator('#input').fill(realCodex ? removalPrompt : 'delete cleanup'); await win.locator('#btn-send').click();
    await win.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 120000 });
    await bob.locator('[data-action="encrypted-approval-accept"]').waitFor({ timeout: 45000 });
    const pending = await snapshot(bob);
    const request = pending.value.approvals.find(entry => entry.turnId === pending.value.activeTurnId && !pending.value.decisions.some(decision => decision.basis === entry.id));
    check(!!request?.fingerprint && request.action.includes('cleanup') && fs.existsSync(path.join(project, 'cleanup/obsolete.txt')),
      'the native host holds the exact removal request before any deletion');
    check(await bob.locator('[data-action="encrypted-approval-accept"]').isDisabled(), 'project participation does not let Bob approve the action');
    await bob.locator('#input').fill(correctionPrompt); await bob.locator('#btn-send').click();
    const direction = bob.locator('#ew-receipts .ew-receipt').filter({ hasText: 'Direction from Bob' });
    await direction.waitFor({ timeout: 30000 });
    const directionCommandId = await direction.getAttribute('data-command-id');
    if (realCodex) await direction.filter({ hasText: 'delivered' }).waitFor({ timeout: 60000 });
    await win.getByLabel('Delegate this action to').selectOption(bobId); await win.locator('[data-action="grant-action-approval"]').click();
    await until(async () => {
      const current = await snapshot(bob);
      return current.value.approvers.some(grant => grant.userId === bobId && grant.turnId === request.turnId && grant.requestId === request.id);
    }, 'exact action grant reaches Bob', 45000);
    check(await bob.locator('[data-action="encrypted-approval-accept"]').isEnabled(), 'the scoped host grant enables Bob’s one decision');
    // Issue #18: the person at the desktop delegated the decision and walked away, so the
    // window goes now - before Bob answers, not after. Everything below this line happens on a
    // machine whose window is closed, which is the only way to show that the execution host is
    // what the teammate is working through rather than somebody else's open app.
    const desktopState = () => app.evaluate(() => global.__plexusDesktop.lifecycle());
    const hostPid = (await desktopState()).runtimePid;
    await app.evaluate(() => global.__plexusDesktop.closeWindow());
    await until(async () => !(await desktopState()).windowVisible, 'the desktop window to close');
    check((await desktopState()).runtimeRunning && (await desktopState()).runtimePid === hostPid,
      'closing the desktop window leaves the same execution host running');
    await bob.locator('[data-approval-id="' + request.id + '"]').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await capture(bob, 'scoped-approval-desktop');
    await bob.locator('[data-action="encrypted-approval-accept"]').click();
    await until(() => !fs.existsSync(path.join(project, 'cleanup')), 'approved workspace removal');
    await direction.filter({ hasText: 'delivered' }).waitFor({ timeout: 60000 });
    await bob.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor({ timeout: 120000 });
    const settled = await snapshot(bob);
    check(settled.value.turn === 'completed' && settled.value.decisions.some(decision => decision.basis === request.id && decision.actor === bobId),
      'the approved provider turn completes with Bob as the recorded decision maker');
    check(!(await desktopState()).windowVisible,
      'and all of it happened with the desktop window closed: the teammate worked through the host, not the app');
    // Back from the tray, the way a person returns to it. The same host, and the same window.
    await app.evaluate(() => global.__plexusDesktop.clickTrayItem('Open Plexus'));
    await until(async () => (await desktopState()).windowVisible, 'the desktop window to reopen');
    check((await desktopState()).runtimePid === hostPid, 'reopening from the tray produced no second execution host');
    check((await snapshot(win)).value.turn === 'completed', 'and the reopened window shows the work its teammate finished');
    const delivery = settled.value.events.find(event => event.type === 'command.receipt' && event.payload.commandId === directionCommandId && event.payload.state === 'delivered');
    check(delivery?.payload.actor === bobId && delivery.payload.turnId === request.turnId &&
      settled.value.messages.some(message => message.actor === bobId && message.text === correctionPrompt),
    'Bob’s direction and delivered receipt retain the actor, command and target turn in authenticated history');
    if (realCodex) {
      check(fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8') === correctedText && initialNotes !== correctedText,
        'real Codex applies Bob’s live correction as the exact synthetic file bytes');
    } else {
      // The demo deliberately acknowledges steering without interpreting it. This extra
      // public follow-up exercises browser-originated writing without claiming native AI.
      await bob.locator('#input').fill(demoCorrectionPrompt); await bob.locator('#btn-send').click();
      await until(() => fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8').includes(demoCorrectionPrompt), 'demo browser-originated correction');
      await bob.locator('#ew-target').filter({ hasText: 'Start a follow-up on this task' }).waitFor({ timeout: 45000 });
      check(fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8') !== initialNotes,
        'demo-only follow-up verifies browser-originated writing; demo steering itself is acknowledgment only');
    }
    const finalText = fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8');
    await bob.locator('#ew-content .ew-file').filter({ hasText: realCodex ? correctedText.trim() : demoCorrectionPrompt }).waitFor({ timeout: 45000 });
    await bob.locator('[data-action="open-diff-source"]').click();
    const source = bob.locator('#ew-content .cu-source-pane');
    await source.filter({ hasText: 'diff.updated' }).waitFor();
    check((await source.innerText()).includes(realCodex ? correctedText.trim() : demoCorrectionPrompt), 'Bob can inspect the source record for the actual file change');
    await capture(bob, 'correction-source-desktop');
    await bob.locator('[data-action="close-source"]').click();
    await win.locator('summary').filter({ hasText: 'Hand off responsibility' }).click();
    await win.getByLabel('New responsible teammate').selectOption(bobId);
    await win.getByLabel('Handoff note').fill('Bob reviewed the real change and owns the next decision.');
    await win.locator('[data-action="encrypted-handoff"]').click();
    await bob.locator('.ew-ownership').filter({ hasText: 'Responsible: Bob' }).waitFor({ timeout: 45000 });
    const handedOver = await snapshot(bob);
    check(handedOver.task.runtimeId === runtimeId && handedOver.value.responsible === bobId && !handedOver.value.outcome &&
      fs.readFileSync(path.join(project, 'NOTES.md'), 'utf8') === finalText && handedOver.value.diffs.some(file => file.path === 'NOTES.md'),
    'responsibility handoff preserves the desktop execution host, file change and open task outcome');
    await bob.locator('.ew-main').evaluate(node => node.scrollTop = 0);
    await capture(bob, 'final-bob-desktop');
    await win.locator('.ew-ownership').filter({ hasText: 'Responsible: Bob' }).waitFor({ timeout: 45000 });
    await win.locator('.ew-main').evaluate(node => node.scrollTop = 0);
    await capture(win, 'final-desktop');
    await bob.setViewportSize({ width: 390, height: 844 });
    await capture(bob, 'review-mobile');
    check(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the separate browser review remains within the 390px viewport');
    await bob.locator('[data-action="toggle-discussion"]').click();
    await bob.locator('#input').waitFor({ state: 'visible' });
    await capture(bob, 'discussion-mobile');
    await bob.locator('[data-action="close-discussion"]').click();
    await bob.setViewportSize({ width: 1487, height: 1058 });
    await bob.locator('summary').filter({ hasText: 'Record the task outcome' }).click();
    await bob.locator('[data-action="outcome-completed"]').click();
    await win.locator('#ew-heading').filter({ hasText: 'Task outcome: completed' }).waitFor({ timeout: 45000 });
    check((await snapshot(win)).value.completedBy === bobId, 'Bob explicitly records task completion after the provider turn and review');
    check(errors.length === 0, 'the separate browser reports no uncaught errors: ' + errors.join(', '));
    check(desktopErrors.length === 0, 'the desktop reports no uncaught errors during collaboration: ' + desktopErrors.join(', '));
    const final = await snapshot(bob);
    const report = { status: 'pass', mode, installed: !!process.env.DESKTOP_EXECUTABLE, taskId, runtimeId, bobId,
      model: realCodex ? 'gpt-5.4-mini' : null, effort: realCodex ? 'medium' : null,
      providerTurns: final.value.events.filter(event => event.type === 'turn.started').length,
      realProviderCorrection: realCodex, directionCommandId, approvalRequestId: request.id, approvalTurnId: request.turnId,
      initialSha256: hash(initialNotes), correctedSha256: hash(finalText),
      correctionPrompt, removalPrompt: realCodex ? removalPrompt : 'delete cleanup',
      tokenUsage: null, tokenUsageReason: 'The product does not expose per-turn token usage in this task snapshot.',
      checks, errors, rendererErrors: { desktop: [...desktopErrors], browser: errors }, captures,
      viewports: ['1487x1058', '390x844'], ranAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, mode + '-results.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    for (const [name, page] of [['desktop', win], ['bob', bob]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(out, mode + '-failure-' + name + '.png') }).catch(() => {});
      fs.writeFileSync(path.join(out, mode + '-failure-' + name + '.txt'), await page.locator('body').innerText().catch(() => ''));
    }
    fs.writeFileSync(path.join(out, mode + '-results.json'), JSON.stringify({ status: 'fail', mode, error: error.stack, checks, errors, captures }, null, 2) + '\n');
    throw error;
  } finally { await browser?.close(); }
};
