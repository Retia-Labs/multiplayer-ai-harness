'use strict';
// Restart acceptance through the actual EncryptedHost + bundled desktop crypto broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Hub } = require('../packages/hub/server');
const { EncryptedHost } = require('../packages/runtime/encrypted-host');
const { Endpoint } = require('../packages/e2ee/endpoint');
const { createDurableEndpoint, endpointChannel } = require('../packages/runtime/durable-endpoint');
const { HubKeyTransport } = require('../packages/e2ee/hub-key-transport.mjs');
const { EnrollmentTransport, announcement } = require('../packages/e2ee/enrollment.mjs');
const { EncryptedTaskTransport, createEncryptedTask, newId } = require('../packages/e2ee/task-log.mjs');
const { matrixUser } = require('../packages/protocol/encrypted-task.mjs');

test('a restarted execution host retains its identity and replays its prior encrypted history', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-durable-host-'));
  const hub = new Hub({ dbFile: path.join(dir, 'hub.sqlite'), log: () => {} });
  const addr = await hub.listen(); const url = 'http://127.0.0.1:' + addr.port;
  const owner = hub.store.createAccount('owner'); const team = hub.store.createTeam('Encrypted', owner.id);
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  const runtime = { id: 'rt_durable_test', teamId: team.id, runtimeToken: 'durable-runtime-secret', encryptedTasksOnly: true,
    projects: new Map([[project, {}]]) };
  hub.store.pairRuntime(runtime.id, team.id, owner.id, runtime.runtimeToken);
  hub.store.upsertRuntime(team.id, { id: runtime.id, taskProtocol: 'encrypted-v1' });
  const ownerEndpoint = await Endpoint.create({ user: matrixUser(owner.id), device: 'OWNER', transport: new HubKeyTransport({ url, token: owner.token, device: 'OWNER' }) });
  const enrollment = new EnrollmentTransport({ url, token: owner.token, endpoint: ownerEndpoint });
  await enrollment.bootstrap(team.id, announcement(ownerEndpoint));
  const projectId = newId('ep'); await enrollment.ownProject(team.id, projectId);
  let child, host;
  let stderr = '';
  const launch = async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [path.join(__dirname, 'fixtures/host-crypto-main.js'), '--crypto-data=' + dir], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const request = endpointChannel(child);
    host = new EncryptedHost({ runtime, url, statePath: path.join(dir, 'outbox.sqlite'), projects: new Map([[projectId, project]]),
      authority: ownerEndpoint.identity(), endpointFactory: (options) => createDurableEndpoint(options, { request }) });
    try { return await host.start(); } catch (error) { error.message += '\n' + stderr; throw error; }
  };
  const stop = async () => {
    const held = host; host = null;
    if (held) { try { await held.endpoint?.close(); } finally { held.state?.close(); } }
    if (child) {
      const process = child; child = null;
      if (process.exitCode === null && process.signalCode === null) {
        const done = new Promise((resolve) => process.once('exit', resolve));
        process.kill();
        const timer = setTimeout(() => process.kill('SIGKILL'), 3000);
        await done; clearTimeout(timer);
      }
    }
  };
  t.after(async () => { try { await stop(); } catch {} ownerEndpoint.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const identity = await launch();
  await ownerEndpoint.confirmEndpoint(identity, { confirmed: true });
  await host.beginReconcile(); await enrollment.answerChallenges(team.id); await host.reconcileMembership();
  const tasks = new EncryptedTaskTransport({ url, token: owner.token });
  const task = { version: 1, id: newId('et'), projectId, runtimeId: runtime.id, teamId: team.id, creatorUserId: owner.id };
  await createEncryptedTask(ownerEndpoint, tasks, { task, writer: identity, payload: { title: 'Durable history', objective: 'Retain this exact objective across restart' } });
  await host.run(task, { runTurn: async (emit) => emit({ method: 'turn/completed', status: 'completed' }) });
  await stop();
  const returned = await launch();
  assert.deepEqual(returned, identity);
  await host.beginReconcile(); await enrollment.answerChallenges(team.id); await host.reconcileMembership();
  const opened = await host.openTask((await tasks.list(team.id)).tasks[0]);
  assert.equal(opened.reader.state.objective, 'Retain this exact objective across restart');
  assert.equal(opened.reader.seq, 2);
});
