'use strict';
// Rendered evidence for issue #9's catch-up screen (template `evidence` in the shared shell).
//
// The states worth capturing are the awkward ones. A screen that only ever gets photographed
// full of content will quietly render "Unknown" as an empty gap, and nobody notices until a
// teammate reads a blank panel as "nothing happened" rather than "we cannot tell".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Hub } = require('../packages/hub/server');
const { catchUp, openSource } = require('../packages/e2ee/catchup.mjs');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-catchup-view-'));
const web = path.join(tmp, 'web');
const out = path.join(root, '.artifacts', 'catchup');
const DESKTOP = { width: 1487, height: 1058 };
const MOBILE = { width: 390, height: 844 };
const checks = [];
const pass = (name, detail) => { checks.push({ name, status: 'pass' }); console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); };
let hub, browser;

// One fixed log, so every capture is the same task in a different condition.
const events = [
  { type: 'task.created', payload: { title: 'Checkout recovery', objective: 'Recover failed checkouts without charging a customer twice.' } },
  { type: 'message.added', payload: { id: 'm1', text: 'Keep retries idempotent.' } },
  { type: 'plan.updated', payload: { steps: [
    { text: 'Trace failed checkouts', status: 'completed' },
    { text: 'Add an idempotent retry', status: 'in-progress' },
    { text: 'Verify duplicate-charge protection', status: 'next' }
  ] } },
  { type: 'decision.recorded', payload: { actor: 'Maya', text: 'Reuse the original payment key', basis: 'm1' } },
  { type: 'diff.updated', payload: { files: [{ path: 'src/checkout/retry.ts' }, { path: 'retry.test.ts' }] } },
  { type: 'activity.recorded', payload: { description: 'Ran the retry suite', paths: ['retry.test.ts'] } }
];
const snapshot = { events, seq: events.length, status: { state: 'caught-up' } };
const base = { responsible: 'Alex', host: "Alex's Mac", provider: 'Codex · Alex’s account', taskId: 'et_fixture', projectId: 'ep_fixture', now: 1_000_000, lastEventAt: 999_000 };

(async () => {
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  for (const file of ['styles.css', 'catchup.js']) fs.copyFileSync(path.join(root, 'apps/web', file), path.join(web, file));
  fs.cpSync(path.join(root, 'apps/web/fonts'), path.join(web, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/catchup-fixture.html'), path.join(web, 'index.html'));

  hub = new Hub({ dbFile: path.join(tmp, 'hub.sqlite'), staticDir: web, log: () => {} });
  const addr = await hub.listen();
  const url = 'http://127.0.0.1:' + addr.port;

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: DESKTOP, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.fixture && document.fonts.status === 'loaded');

  const capture = async (name, viewport) => {
    await page.setViewportSize(viewport);
    const file = path.join(out, name + '-' + viewport.width + '.png');
    await page.screenshot({ path: file });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ': horizontal clipping');
    return file;
  };

  // --- current: everything the template's required slots ask for ---
  const current = catchUp(snapshot, { ...base, hostConnected: true });
  assert.equal(await page.evaluate((p) => fixture.render(p), current), 'current');
  const text = await page.textContent('#catchup-view');
  for (const required of ['The objective', 'Decided together', 'Current plan', 'Recent changes', 'Waiting on']) {
    assert.ok(text.includes(required), 'missing slot: ' + required);
  }
  assert.ok(text.includes('Recover failed checkouts'), 'objective');
  assert.ok(text.includes('Maya'), 'decision actor');
  assert.ok(text.includes("Alex's Mac"), 'execution host');
  assert.ok(text.includes('Ran the retry suite'), 'activity is rendered, not projected and dropped');
  assert.ok(text.includes('Status'), 'outcome is shown');
  assert.ok(text.includes('in progress'), 'outcome value');
  assert.equal((await page.$$('.cu-tag-recorded')).length >= 4, true);
  assert.equal((await page.$$('.cu-tag-derived')).length >= 1, true);
  await capture('catchup-current', DESKTOP);
  await capture('catchup-current', MOBILE);
  pass('every required slot renders, with recorded and derived visibly distinct', 'desktop + mobile captured');

  // --- unknown: the host stopped talking. This must not read as "up to date". ---
  assert.equal(await page.evaluate((p) => fixture.render(p), catchUp(snapshot, { ...base, hostConnected: false })), 'unknown');
  const unknownText = await page.textContent('#catchup-view');
  assert.ok(unknownText.includes('Unknown'), 'freshness word');
  assert.ok(unknownText.includes('not connected'), 'freshness explanation');
  await capture('catchup-unknown', DESKTOP);
  pass('a disconnected host renders as Unknown with the reason in words', 'not colour alone');

  // --- stale: quiet, but not lost ---
  assert.equal(await page.evaluate((p) => fixture.render(p), catchUp(snapshot, { ...base, hostConnected: true, now: 10 ** 9 })), 'stale');
  assert.ok((await page.textContent('#catchup-view')).includes('Quiet'));
  await capture('catchup-stale', DESKTOP);
  pass('a quiet task renders as Quiet, distinct from disconnected', 'stale');

  // --- empty: nothing recorded, and it says so in each slot ---
  assert.equal(await page.evaluate((p) => fixture.render(p), catchUp({ events: [], seq: 0, status: { state: 'caught-up' } }, {})), 'unknown');
  const emptyText = await page.textContent('#catchup-view');
  assert.ok(emptyText.includes('no creation event'), 'objective explains itself');
  assert.ok(emptyText.includes('No decision has been recorded'), 'decisions explain themselves');
  assert.equal((await page.$$('.cu-missing')).length >= 4, true);
  await capture('catchup-empty', DESKTOP);
  pass('an empty log renders explanations in every slot, not blank space', 'no fabricated content');

  // --- source open and source unavailable ---
  await page.evaluate((p) => fixture.render(p), current);
  await page.click('.cu-source');
  const clicked = await page.evaluate(() => globalThis.opened);
  assert.deepEqual(clicked, { seq: 1, type: 'task.created' });
  assert.equal(await page.evaluate((o) => fixture.renderSource(o), openSource(snapshot, clicked)), 'open');
  assert.ok((await page.textContent('#source-pane')).includes('Recover failed checkouts'));
  pass('a source link opens the event behind the claim', 'event 1');

  assert.equal(await page.evaluate((o) => fixture.renderSource(o), openSource(snapshot, { seq: 99, type: 'task.created' })), 'unavailable');
  assert.ok((await page.textContent('#source-pane')).includes('not available'));
  pass('an unresolvable source renders as unavailable, not as an empty panel', 'source-unavailable');

  // The browser resolver and the projection's openSource must not drift apart.
  const probes = [{ seq: 1, type: 'task.created' }, { seq: 4, type: 'decision.recorded' }, { seq: 99, type: 'task.created' }, { seq: 2, type: 'plan.updated' }];
  for (const probe of probes) {
    const inBrowser = await page.evaluate(([snap, p]) => {
      const r = window.PlexusCatchup.resolveSource(snap, p);
      return { available: r.available, type: r.event ? r.event.type : null };
    }, [snapshot, probe]);
    const inNode = openSource(snapshot, probe);
    assert.equal(inBrowser.available, inNode.available, 'resolver disagreement on ' + JSON.stringify(probe));
    assert.equal(inBrowser.type, inNode.event ? inNode.event.type : null);
  }
  pass('the browser resolver agrees with the projection on every probe', probes.length + ' references');

  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({
    ranAt: new Date().toISOString(), browser: await page.evaluate(() => navigator.userAgent),
    viewports: [DESKTOP, MOBILE], checks
  }, null, 2) + '\n');
  console.log('\n' + checks.length + ' catch-up view checks passed');
})().then(async () => {
  if (browser) await browser.close();
  if (hub) await hub.close();
  process.exit(0);
}).catch(async (error) => {
  console.error('CATCH-UP VIEW FAILED\n', error);
  try { if (browser) await browser.close(); } catch {}
  try { if (hub) await hub.close(); } catch {}
  process.exit(1);
});
