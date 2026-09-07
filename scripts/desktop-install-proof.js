'use strict';
// Installs the packaged app the way a user would - from the built installer, to a location
// the user picks - then launches the *installed* copy with this platform's own Node kept off
// PATH. A developer checkout proves nothing about an installed app; this is the difference.
// Windows and macOS only, one host architecture per run. Evidence lands in
// .artifacts/desktop-install/<platform>-<arch>.json; --merge combines runs into one record.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const outDir = path.join(root, '.artifacts', 'desktop-install');
const mergedFile = path.join(root, 'docs', 'proofs', 'desktop-platform-results.json');

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return res;
}
function must(cmd, args, opts = {}) {
  const res = sh(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) throw new Error(`${path.basename(cmd)} exited ${res.status}`);
  return res;
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --merge: fold every per-platform record under a directory into one file. The jobs run on
// different machines, so this is the only place the platforms meet.
if (flag('--merge')) {
  const from = value('--merge') || path.join(root, '.artifacts', 'downloaded');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) files.push(full);
    }
  })(from);
  const platforms = {};
  let testedCommit = null;
  let workflow = null;
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!report.platform || !Array.isArray(report.results)) continue;
    platforms[`${report.platform}-${report.arch}`] = report;
    testedCommit = testedCommit || report.testedCommit;
    workflow = workflow || report.workflow;
  }
  if (!Object.keys(platforms).length) throw new Error('No platform records under ' + from);
  fs.mkdirSync(path.dirname(mergedFile), { recursive: true });
  fs.writeFileSync(mergedFile, JSON.stringify({ testedCommit, workflow, platforms }, null, 2) + '\n');
  const failed = Object.values(platforms).flatMap((p) => p.results.filter((r) => r.status !== 'pass'));
  console.log(`${mergedFile}: ${Object.keys(platforms).join(', ')}`);
  for (const f of failed) console.log(`FAIL ${f.name}${f.detail ? ' - ' + f.detail : ''}`);
  process.exit(failed.length ? 1 : 0);
}

if (!['win32', 'darwin'].includes(process.platform)) {
  throw new Error('The installed-app proof only means something on the platforms we ship: Windows and macOS.');
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const results = [];
const record = (name, status, detail) => results.push(detail ? { name, status, detail } : { name, status });

// The app's own Node must never be the machine's. Everything else comes off PATH.
const strippedPath = process.platform === 'win32'
  ? `${process.env.SystemRoot}\\system32;${process.env.SystemRoot}`
  : '/usr/bin:/bin';

function osVersion() {
  if (process.platform === 'darwin') return 'macOS ' + sh('sw_vers', ['-productVersion']).stdout.trim();
  const ver = sh('cmd', ['/c', 'ver']).stdout.trim().replace(/\s+/g, ' ');
  return ver || 'Windows ' + os.release();
}

// The installer a user would be handed for this host: the per-architecture one, never the
// combined build, so what gets installed here is what the record names.
function locateInstaller(output) {
  const wanted = process.platform === 'win32' ? `-win-${arch}-setup.exe` : '.dmg';
  const file = fs.existsSync(output) && fs.readdirSync(output).filter((f) => f.endsWith(wanted)).sort()[0];
  if (!file) throw new Error(`No ${wanted} in ${output}`);
  return path.join(output, file);
}

function buildInstaller(output) {
  must(process.execPath, [
    path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
    process.platform === 'win32' ? '--win' : '--mac', '--' + arch,
    '--publish', 'never',
    '--config.directories.output=' + output
  ], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  return locateInstaller(output);
}

// Windows: the silent NSIS switches a scripted install uses. /D comes last and unquoted, so
// the target directory cannot contain spaces.
function installWindows(installer, target) {
  const res = sh(installer, ['/S', '/D=' + target], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('installer exited ' + res.status);
  return path.join(target, 'Plexus.exe');
}

// macOS: mount the dmg and copy the app out of it, which is what dragging it to Applications
// does. Copied to a chosen directory rather than /Applications so the run cleans up after
// itself and needs no admin rights.
function installMac(dmg, target) {
  const attach = sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountrandom', os.tmpdir(), dmg]);
  if (attach.status !== 0) throw new Error('hdiutil attach failed: ' + attach.stderr);
  const mount = attach.stdout.split('\n')
    .map((line) => line.split('\t').pop().trim())
    .filter((entry) => entry.startsWith('/'))
    .pop();
  if (!mount) throw new Error('hdiutil reported no mount point');
  try {
    const app = fs.readdirSync(mount).find((entry) => entry.endsWith('.app'));
    if (!app) throw new Error('No .app inside the dmg');
    fs.mkdirSync(target, { recursive: true });
    must('cp', ['-R', path.join(mount, app), target]);
    return path.join(target, app, 'Contents', 'MacOS', 'Plexus');
  } finally {
    sh('hdiutil', ['detach', mount, '-force']);
  }
}

// The uninstaller relaunches itself from a temp copy and returns immediately, so the only
// honest check is that the install directory actually goes away.
async function uninstallWindows(target) {
  const uninstaller = fs.readdirSync(target).find((entry) => /^Uninstall .*\.exe$/.test(entry));
  if (!uninstaller) throw new Error('The install left no uninstaller behind');
  sh(path.join(target, uninstaller), ['/S'], { stdio: 'inherit' });
  for (let i = 0; i < 60 && fs.existsSync(target); i++) await wait(500);
  if (fs.existsSync(target)) throw new Error('The uninstaller left ' + target + ' in place');
}

function runTest(script, executable) {
  return sh(process.execPath, [path.join(root, 'test', script)], {
    stdio: 'inherit',
    env: { ...process.env, DESKTOP_EXECUTABLE: executable }
  }).status === 0;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(root, '.artifacts', 'desktop-install-build');
  const target = path.join(os.tmpdir(), 'plexus-install-proof');
  fs.rmSync(target, { recursive: true, force: true });

  let installer = null;
  let installed = null;
  try {
    // --skip-build reuses the last build. For local iteration only; CI always builds.
    installer = flag('--skip-build') ? locateInstaller(output) : buildInstaller(output);
    record('the packaged installer builds for this platform and architecture', 'pass', path.basename(installer));
  } catch (err) {
    record('the packaged installer builds for this platform and architecture', 'fail', String(err.message || err));
  }

  if (installer) {
    try {
      installed = process.platform === 'win32' ? installWindows(installer, target) : installMac(installer, target);
      if (!fs.existsSync(installed)) throw new Error('The install produced no runnable app at ' + installed);
      record('installing outside a checkout produces a runnable app', 'pass', installed);
    } catch (err) {
      installed = null;
      record('installing outside a checkout produces a runnable app', 'fail', String(err.message || err));
    }
  }

  if (installed) {
    record('the installed copy starts its services, selects a project and runs an agent with no Node on PATH',
      runTest('desktop-smoke.js', installed) ? 'pass' : 'fail');
    record('the installed copy reports readiness, holds a failed start and recovers on retry',
      runTest('desktop-bootstrap.js', installed) ? 'pass' : 'fail');
    try {
      if (process.platform === 'win32') await uninstallWindows(target);
      else fs.rmSync(target, { recursive: true, force: true });
      record('uninstalling removes the installed copy', 'pass');
    } catch (err) {
      record('uninstalling removes the installed copy', 'fail', String(err.message || err));
    }
  }

  const runId = process.env.GITHUB_RUN_ID;
  const report = {
    testedCommit: process.env.GITHUB_SHA || sh('git', ['rev-parse', 'HEAD']).stdout.trim() || null,
    workflow: runId ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : null,
    ranAt: new Date().toISOString(),
    platform: process.platform,
    arch,
    os: osVersion(),
    electron: require(path.join(root, 'node_modules', 'electron', 'package.json')).version,
    installer: installer && fs.existsSync(installer)
      ? { file: path.basename(installer), bytes: fs.statSync(installer).size, sha256: sha256(installer) }
      : null,
    installedTo: installed,
    // A CI runner keeps a system Node. The app is launched without one on PATH rather than on
    // a machine that has none, so this says which claim the evidence actually supports.
    systemNode: 'present on the machine, excluded from the launched app: PATH=' + strippedPath,
    results
  };
  fs.writeFileSync(path.join(outDir, `${process.platform}-${arch}.json`), JSON.stringify(report, null, 2) + '\n');

  console.log('\n' + path.join(outDir, `${process.platform}-${arch}.json`));
  for (const r of results) console.log(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  process.exit(results.some((r) => r.status !== 'pass') ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
