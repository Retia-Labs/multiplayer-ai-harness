/*
 * End-to-end smoke test: launches the real Electron app, drives the UI, and
 * verifies the home hero, demo agent (reasoning + plan + file edits + shell),
 * @ mentions, slash prompts, the Changes review panel with commit, worktree
 * threads, archiving, automations and settings.
 * Run with: xvfb-run -a npm run smoke
 */
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { localShell } = require('../packages/runtime/executors');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  // Isolated userData + a scratch git project the agent can inspect.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-clone-'));
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'hello.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(project, 'README.md'), '# Scratch project\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', {
    cwd: project, shell: localShell().bin
  });
  // A working-tree change so the diff panel has something to show.
  fs.appendFileSync(path.join(project, 'hello.js'), 'console.log("changed");\n');

  // Pre-seed settings so the app opens this project without the native dialog.
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    theme: 'dark', model: 'gpt-5.1-codex-max', effort: 'medium', mode: 'agent',
    openaiApiKey: '', openaiBaseUrl: 'https://api.openai.com/v1',
    notifications: false, recentProjects: [project], customPrompts: [], automations: []
  }));

  const shotDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(shotDir, { recursive: true });

  console.log('Launching Electron…');
  const app = await electron.launch({
    args: ['src/main/main.js', '--user-data-dir=' + userData, '--no-sandbox'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#sidebar', { timeout: 15000 });
  await win.setViewportSize?.({ width: 1360, height: 860 }).catch(() => {});
  console.log('Window loaded: ' + (await win.title()));

  const hidden = (sel) => win.waitForFunction((s) => document.querySelector(s).classList.contains('hidden'), sel);
  const visible = (sel) => win.waitForFunction((s) => !document.querySelector(s).classList.contains('hidden'), sel);

  // ---- Home ----
  assert((await win.title()) === 'Codex', 'window title is "Codex"');
  await visible('#home-view');
  assert(await win.isVisible('.home-hero h1'), 'home hero visible');
  assert((await win.textContent('.home-hero h1')).includes('What are we coding'), 'hero headline matches Codex');
  await win.waitForFunction(() => document.querySelector('#home-project-label').textContent === 'project', { timeout: 10000 });
  assert(true, 'project auto-selected from recents');
  assert(await win.isVisible('#composer-host-home .composer'), 'composer docked in home hero');
  assert((await win.$$('.suggestion')).length >= 4, 'suggestion chips rendered');
  const models = await win.$$eval('#model-select option', (os_) => os_.map((o) => o.value));
  assert(models.includes('gpt-5.1-codex-max') && models.includes('gpt-5.1'), 'model picker has codex model family');
  assert(await win.isVisible('#effort-select'), 'reasoning effort selector present');
  await win.screenshot({ path: path.join(shotDir, 'home.png') });

  // ---- Demo agent: plan + reasoning + file edit + shell ----
  await win.fill('#input', 'Create a NOTES.md summarizing this repo');
  await win.press('#input', 'Enter');
  await visible('#chat-view');
  await win.waitForSelector('.msg-user .bubble', { timeout: 5000 });
  assert(true, 'chat view opens with user message');
  await win.waitForSelector('.reasoning', { timeout: 15000 });
  assert(true, 'reasoning ("thinking") item streamed');
  await win.waitForSelector('.plan-card', { timeout: 15000 });
  assert(true, 'plan checklist card rendered');
  await win.waitForSelector('.edit-card', { timeout: 20000 });
  const editPath = await win.textContent('.edit-card .edit-path');
  assert(editPath.trim() === 'NOTES.md', 'file edit card shows NOTES.md');
  assert(fs.existsSync(path.join(project, 'NOTES.md')), 'NOTES.md actually written to disk');
  await win.waitForSelector('.cmd-card', { timeout: 15000 });
  assert(true, 'shell command cards rendered');
  await win.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), { timeout: 40000 });
  await win.waitForFunction(() => {
    const steps = [...document.querySelectorAll('.plan-step')];
    return steps.length >= 3 && steps.every((s) => s.classList.contains('completed'));
  }, { timeout: 10000 });
  assert(true, 'plan steps all marked completed');
  const assistantText = await win.textContent('.msg-assistant:last-of-type');
  assert(assistantText.length > 20, 'assistant streamed a final summary');
  const threadTitle = await win.textContent('.thread-item.active .t-title');
  assert(threadTitle.includes('Create a NOTES.md'), 'thread auto-titled from first message');
  await win.screenshot({ path: path.join(shotDir, 'thread.png') });
  await win.screenshot({ path: path.join(shotDir, 'screenshot.png') });

  // ---- @ file mentions ----
  await win.click('#input');
  await win.fill('#input', 'Look at @hel');
  await win.waitForSelector('.composer-popup:not(.hidden) .popup-item', { timeout: 8000 });
  const mention = await win.textContent('.composer-popup .popup-item.sel .pi-sub');
  assert(mention.trim() === 'hello.js', '@ mention popup suggests hello.js');
  await win.press('#input', 'Tab');
  const inputVal = await win.inputValue('#input');
  assert(inputVal.includes('hello.js'), 'mention inserted into composer');
  await win.fill('#input', '');

  // ---- slash prompts ----
  await win.fill('#input', '/rev');
  await win.waitForSelector('.composer-popup:not(.hidden) .popup-item', { timeout: 5000 });
  const slash = await win.textContent('.composer-popup .popup-item.sel .pi-title');
  assert(slash.trim() === '/review', 'slash popup suggests /review');
  await win.press('#input', 'Enter');
  const expanded = await win.inputValue('#input');
  assert(expanded.startsWith('Review my current'), 'slash prompt expands to full prompt');
  await win.fill('#input', '');

  // ---- Changes panel: file list, diff table, commit ----
  await win.click('#btn-changes');
  await visible('#diff-view');
  await win.waitForSelector('.dfl-item', { timeout: 10000 });
  const dflPaths = await win.$$eval('.dfl-item .dfl-path', (ns) => ns.map((n) => n.textContent.trim()));
  assert(dflPaths.includes('hello.js') && dflPaths.includes('NOTES.md'), 'file list shows hello.js and NOTES.md');
  await win.waitForSelector('.diff-table tr.add', { timeout: 5000 });
  assert(true, 'diff table renders added lines with line numbers');
  await win.screenshot({ path: path.join(shotDir, 'changes.png') });
  await win.fill('#commit-msg', 'test: commit from Codex clone');
  await win.click('#btn-commit');
  await win.waitForSelector('.diff-empty', { timeout: 10000 });
  assert(true, 'commit clears the working tree (diff panel empty)');
  const gitLog = execSync('git log --oneline -1', { cwd: project }).toString();
  assert(gitLog.includes('test: commit from Codex clone'), 'commit actually landed in git history');
  await win.click('#btn-close-diff');

  // ---- Worktree thread ----
  await win.click('#btn-new-thread');
  await visible('#home-view');
  await win.check('#worktree-check');
  await win.fill('#input', 'Explore this repo');
  await win.press('#input', 'Enter');
  await visible('#chat-view');
  await visible('#worktree-badge');
  assert(true, 'worktree badge shown for isolated thread');
  const wtBranch = (await win.textContent('#project-branch')).trim();
  assert(wtBranch.startsWith('codex/'), 'thread runs on its own codex/* branch (got: ' + wtBranch + ')');
  const wtList = execSync('git worktree list', { cwd: project }).toString();
  assert(wtList.split('\n').filter(Boolean).length >= 2, 'git worktree actually created');
  await win.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), { timeout: 40000 });

  // ---- Archive ----
  const firstThread = (await win.$$('.thread-item'))[1] || (await win.$$('.thread-item'))[0];
  await firstThread.hover();
  await firstThread.$eval('.t-act[title="Archive"]', (b) => b.click());
  await visible('#archived-section');
  assert(true, 'archived section appears after archiving a thread');

  // ---- Automations ----
  await win.click('#btn-automations');
  await visible('#automations-modal');
  await win.fill('#auto-name', 'Nightly review');
  await win.fill('#auto-prompt', 'Review recent commits and summarize risks');
  await win.click('#btn-add-automation');
  await win.waitForSelector('.automation-row', { timeout: 5000 });
  const autoSub = await win.textContent('.automation-row .ar-sub');
  assert(autoSub.includes('daily'), 'automation saved with daily schedule');
  await win.click('#btn-close-automations');

  // ---- Settings ----
  await win.click('#btn-settings');
  await visible('#settings-modal');
  assert(await win.isVisible('#setting-api-key'), 'settings modal opens with API key field');
  assert(await win.isVisible('#setting-custom-models'), 'custom models field present');
  await win.fill('#prompt-name', 'deploy');
  await win.fill('#prompt-text', 'Deploy the app to staging');
  await win.click('#btn-add-prompt');
  await win.waitForSelector('.prompt-row', { timeout: 5000 });
  assert(true, 'custom slash prompt added in settings');
  await win.click('#btn-save-settings');
  await hidden('#settings-modal');

  await app.close();
  console.log('\nAll smoke tests passed ✅');
  process.exit(0);
})().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
