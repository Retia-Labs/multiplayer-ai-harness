'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercise failures through actual UI actions and transport failures. The same
// module runs against Chromium and the installed desktop's shared renderer.
module.exports = async function pilotUiStates(page, out) {
  await page.setViewportSize({ width: 1487, height: 1058 });
  await page.locator('#nav-fleet').click();
  await page.evaluate(() => {
    window.__pilotOriginalFetch = window.fetch;
    window.fetch = (input, options) => {
      const url = String(input), fault = window.__pilotFault;
      if (fault === 'enrollment' && url.includes('/api/enrollment?') || fault === 'provider' && url.endsWith('/api/encrypted-tasks') && options?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ error: fault === 'enrollment' ? 'enrollment_failed' : 'codex_host_tools_auth_mode_unsupported' }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      return window.__pilotOriginalFetch(input, options);
    };
    window.__pilotFault = 'enrollment';
  });
  try {
    await page.locator('#pilot-setup [data-stage="endpoint"][data-state="failed"]').waitFor({ timeout: 30000 });
    await page.locator('[data-action="preview-diagnostics"]').click();
    const report = JSON.parse(await page.locator('.pilot-export').innerText());
    assert.equal(report.stages.find(row => row.stage === 'endpoint').code, 'enrollment_failed');
    await page.screenshot({ path: path.join(out, 'enrollment-failure.png'), scale: 'css' });
    await page.locator('[data-action="close-pilot-dialog"]').click();
  } finally { await page.evaluate(() => { window.__pilotFault = null; }); }
  await page.locator('#pilot-setup [data-stage="endpoint"][data-state="ready"]').waitFor({ timeout: 30000 });
  await page.evaluate(() => { window.__pilotFault = 'provider'; });
  try {
    await page.locator('#input').fill('Diagnostic failure fixture'); await page.locator('#btn-send').click();
    await page.locator('#pilot-setup [data-stage="provider"][data-state="failed"]').waitFor({ timeout: 30000 });
    await page.locator('[data-action="preview-diagnostics"]').click();
    const report = JSON.parse(await page.locator('.pilot-export').innerText());
    assert.equal(report.stages.find(row => row.stage === 'provider').code, 'account_unsupported');
    assert.doesNotMatch(JSON.stringify(report), /Diagnostic failure fixture/);
    await page.screenshot({ path: path.join(out, 'unsupported-account.png'), scale: 'css' });
    await page.locator('[data-action="close-pilot-dialog"]').click();
  } finally { await page.evaluate(() => { window.fetch = window.__pilotOriginalFetch; delete window.__pilotOriginalFetch; delete window.__pilotFault; }); }
  await page.locator('#input').fill(''); await page.locator('#provider-select').selectOption('demo');
  await page.locator('[data-action="setup-recovery"]').click();
  await page.locator('[name="owner-recovery-key"]').fill('invalid-customer-key');
  await page.locator('[name="owner-kit-file"]').setInputFiles({ name: 'invalid-kit.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.locator('[data-action="stage-owner-recovery"]').click();
  await page.locator('#recovery-view .ew-inline-error').waitFor({ timeout: 30000 });
  await page.locator('#nav-fleet').click(); await page.locator('[data-action="preview-diagnostics"]').click();
  const report = JSON.parse(await page.locator('.pilot-export').innerText());
  assert.equal(report.stages.find(row => row.stage === 'recovery').code, 'recovery_failed');
  assert.doesNotMatch(JSON.stringify(report), /invalid-customer-key|invalid-kit/);
  await page.screenshot({ path: path.join(out, 'recovery-failure.png'), scale: 'css' });
  await page.locator('[data-action="close-pilot-dialog"]').click();
  console.log('PASS onboarding recovers from enrollment failure and safely reports unsupported-account and invalid-kit failures');
};
