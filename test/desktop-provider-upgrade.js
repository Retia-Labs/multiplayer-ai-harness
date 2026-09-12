'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cycle } = require('./desktop-upgrade-cycle');

// The old binary configures the real account but retains its obsolete model.
// All task/profile/project data belongs to desktop-smoke's disposable fixture.
module.exports = async function providerUpgrade({ app, win, launch, quitApp, userData, dataDir, runtimeConfig, project }) {
  await win.waitForFunction(() => {
    const s = window.__plexus.state;
    return s.encryptedSnapshots.get(s.activeThreadId)?.turn === 'failed';
  }, null, { timeout: 60000 });
  const before = await win.evaluate(() => {
    const s = window.__plexus.state;
    return { taskId: s.activeThreadId, identity: s.encryptedIdentity,
      events: s.encryptedSnapshots.get(s.activeThreadId).events };
  });
  assert.ok(before.events.some(event => event.type === 'turn.completed' && event.payload.status === 'failed'));
  assert.equal(fs.existsSync(path.join(project, 'NOTES.md')), false);
  const hostId = await win.evaluate(() => window.harnessDesktop.runtimeId());
  const fromVersion = await app.evaluate(({ app }) => app.getVersion());
  const account = JSON.parse(fs.readFileSync(runtimeConfig, 'utf8')).codexHostTools;
  assert.match(account.accountBinding, /^[a-f0-9]{64}$/);
  const services = await app.evaluate(() => global.__plexusDesktop.servicePids());
  assert.ok([services.runtime, services.hub].every(pid => Number.isInteger(pid) && pid > 0));
  await quitApp(app);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  for (let i = 0; i < 100 && (alive(services.runtime) || alive(services.hub)); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(services.runtime) || alive(services.hub), false);
  const configFile = process.env.PLEXUS_PROVIDER_UPGRADE_CYCLE;
  const upgrade = cycle(configFile, { userData, dataDir });
  assert.equal(upgrade.upgrade(), process.env.DESKTOP_EXECUTABLE);
  app = await launch();
  try { win = await app.firstWindow(); } catch (error) { await quitApp(app); throw error; }
  // Hand the new app to the caller before assertions so its finally can quit it
  // even when restored-state verification fails.
  const verify = async () => {
    const toVersion = await app.evaluate(({ app }) => app.getVersion());
    assert.notEqual(fromVersion, toVersion);
    await win.waitForSelector('#app:not(.hidden)', { timeout: 60000 });
    await win.locator('.encrypted-task-row[data-task-id="' + before.taskId + '"]').click({ timeout: 30000 });
    await win.waitForFunction(id => window.__plexus.state.encryptedSnapshots.has(id), before.taskId);
    assert.deepEqual(await win.evaluate(() => window.__plexus.state.encryptedIdentity), before.identity);
    assert.equal(await win.evaluate(() => window.harnessDesktop.runtimeId()), hostId);
    assert.deepEqual(JSON.parse(fs.readFileSync(runtimeConfig, 'utf8')).codexHostTools, account);
    const restored = await win.evaluate(id => window.__plexus.state.encryptedSnapshots.get(id), before.taskId);
    assert.deepEqual(restored.events.slice(0, before.events.length), before.events);
    assert.notEqual(restored.turn, 'running');
    for (const event of restored.events.slice(before.events.length)) {
      assert.equal(event.type, 'recovery.required');
      assert.equal(event.payload.reason, 'host_restarted');
    }
    assert.equal(fs.existsSync(path.join(project, 'NOTES.md')), false);
    await win.waitForFunction(() => window.__plexus.state.runtimes.some(runtime =>
      runtime.providers.some(provider => provider.id === 'codex-cli' && provider.configured && provider.models.includes('gpt-5.5'))));
    await win.locator('#provider-select').selectOption('codex-cli');
    await win.locator('#model-select').selectOption('gpt-5.5');
    await win.locator('#effort-select').selectOption('medium');
    // Restored tasks may default to inspection. Explicitly authorize host edits
    // through the same public control a person uses, never a policy override.
    await win.locator('#preset-select').selectOption('agent');
    await win.fill('#input', 'Read a.txt using the host tool and create NOTES.md with exactly its contents, including its final newline.');
    await win.click('#btn-send');
    return () => fs.writeFileSync(path.join(path.dirname(configFile), 'result.json'), JSON.stringify({
      fromVersion, toVersion, identityPreserved: true, encryptedHistoryReadable: true,
      accountConfigurationPreserved: true, obsoleteTaskRecoveredByExplicitModelSelection: true,
      realProviderCollaboration: 'pass', model: 'gpt-5.5', reinstall: 'not-run', matchingBackupRollback: 'not-run'
    }, null, 2));
  };
  return { app, win, verify };
};
