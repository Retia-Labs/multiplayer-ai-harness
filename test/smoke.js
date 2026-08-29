/*
 * End-to-end smoke test: launches the real Electron app, drives the UI,
 * and verifies threads, the demo agent (streaming + real tool execution),
 * and the Changes diff panel. Run with: xvfb-run -a npm run smoke
 */
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

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
    cwd: project, shell: '/bin/bash'
  });
  // A working-tree change so the diff panel has something to show.
  fs.appendFileSync(path.join(project, 'hello.js'), 'console.log("changed");\n');

  // Pre-seed settings so the app opens this project without the native dialog.
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    theme: 'dark', model: 'gpt-5.1-codex', mode: 'agent',
    openaiApiKey: '', openaiBaseUrl: 'https://api.openai.com/v1',
    recentProjects: [project]
  }));

  console.log('Launching Electron…');
  const app = await electron.launch({
    args: ['.', '--user-data-dir=' + userData, '--no-sandbox'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
  });
  // Electron ignores --user-data-dir for app.getPath('userData') unless set early;
  // override via the main process instead.
  await app.evaluate(async ({ app: eapp }, dir) => {
    // userData was already read at startup; this is for confirmation only.
    return eapp.getPath('userData');
  }, userData).catch(() => {});

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#sidebar', { timeout: 15000 });
  console.log('Window loaded: ' + (await win.title()));

  assert((await win.title()) === 'Codex', 'window title is "Codex"');
  assert(await win.isVisible('#btn-new-thread'), 'new-thread button visible');
  assert(await win.isVisible('.composer textarea'), 'composer visible');

  // Project loaded from recents
  await win.waitForFunction(() => document.querySelector('#project-name').textContent !== 'No project', { timeout: 10000 });
  const projName = await win.textContent('#project-name');
  assert(projName.trim() === 'project', 'project auto-opened from recents (got: ' + projName + ')');
  await win.waitForFunction(() => !document.querySelector('#project-branch').classList.contains('hidden'));
  const branch = (await win.textContent('#project-branch')).trim();
  assert(branch.startsWith('main'), 'git branch shown in topbar (got: ' + branch + ')');

  // New thread + send a message that makes the demo agent run real commands
  await win.click('#btn-new-thread');
  await win.fill('.composer textarea', 'What files are in this repo?');
  await win.press('.composer textarea', 'Enter');
  await win.waitForSelector('.msg-user .bubble', { timeout: 5000 });
  assert(true, 'user message rendered');

  await win.waitForSelector('#working:not(.hidden)', { timeout: 5000 });
  assert(true, 'working indicator appears while agent runs');

  // Demo agent should stream text and run `ls -la` + `git status` as tool cards
  await win.waitForSelector('.cmd-card', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelectorAll('.cmd-card').length >= 2, { timeout: 20000 });
  assert(true, 'agent executed shell tool calls (command cards rendered)');
  await win.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.cmd-card .cmd-output')];
    return cards.some((c) => c.textContent.includes('hello.js'));
  }, { timeout: 20000 });
  assert(true, 'command output contains real file listing (hello.js)');

  await win.waitForFunction(() => document.querySelector('#working').classList.contains('hidden'), { timeout: 30000 });
  const assistantText = await win.textContent('.msg-assistant:last-of-type');
  assert(assistantText.length > 20, 'assistant streamed a final summary');

  // Thread list got titled from the first message
  const threadTitle = await win.textContent('.thread-item.active .t-title');
  assert(threadTitle.includes('What files'), 'thread auto-titled from first message');

  // Changes panel shows the working-tree diff
  await win.click('#btn-changes');
  await win.waitForSelector('.diff-file', { timeout: 10000 });
  const diffPath = await win.textContent('.diff-file-path');
  assert(diffPath.trim() === 'hello.js', 'diff panel lists changed file');
  const addLine = await win.textContent('.diff-line.add .dl-text');
  assert(addLine.includes('changed'), 'diff shows added line content');
  await win.click('#btn-close-diff');

  // Persistence: thread survives in store
  await win.waitForFunction(() => document.querySelectorAll('.thread-item').length >= 1);
  assert(true, 'thread persisted in sidebar');

  // Settings modal opens
  await win.click('#btn-settings');
  await win.waitForSelector('#settings-modal:not(.hidden)');
  assert(await win.isVisible('#setting-api-key'), 'settings modal opens with API key field');
  await win.click('#btn-close-settings');

  // Screenshot for the README
  const shotDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(shotDir, { recursive: true });
  await win.screenshot({ path: path.join(shotDir, 'screenshot.png') });
  console.log('Saved docs/screenshot.png');

  await app.close();
  console.log('\nAll smoke tests passed ✅');
  process.exit(0);
})().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
