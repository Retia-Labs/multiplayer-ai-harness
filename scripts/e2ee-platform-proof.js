'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('This proof requires supported Windows or macOS OS-backed storage.');
const run = (script, args, env = process.env) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
const output = path.join(root, '.artifacts', 'e2ee-app');
run(path.join(root, 'node_modules', 'electron-builder', 'cli.js'), [
  '--dir', '--publish', 'never', process.platform === 'win32' ? '--win' : '--mac',
  process.arch === 'arm64' ? '--arm64' : '--x64',
  '--config.extraMetadata.main=packages/e2ee/desktop-proof-main.js',
  '--config.directories.output=' + output
], { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
const candidates = process.platform === 'win32'
  ? [path.join(output, process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'Plexus.exe')]
  : ['mac-arm64', 'mac'].map((dir) => path.join(output, dir, 'Plexus.app', 'Contents', 'MacOS', 'Plexus'));
const binary = candidates.find((file) => fs.existsSync(file));
if (!binary) throw new Error('Packaged experiment executable is missing.');
run(path.join(root, 'test', 'e2ee-complete.js'), [], { ...process.env, E2EE_DESKTOP_EXECUTABLE: binary });
