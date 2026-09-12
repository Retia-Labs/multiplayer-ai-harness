'use strict';
// An installed old/new/reinstall/backup-restore drill, entirely in a disposable
// installation. Never points a test at the user's real Plexus profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { install, uninstall } = require('./desktop-installer');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error('Usage: npm run test:desktop:upgrade -- --from OLD_INSTALLER --to NEW_INSTALLER');
  return fs.realpathSync(args[i + 1]);
}
let dir;
(async () => {
try {
  const from = option('--from'), to = option('--to');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-upgrade-'));
  const target = path.join(dir, 'installed');
  const executable = install(from, target);
  const config = path.join(dir, 'cycle.json');
  fs.writeFileSync(config, JSON.stringify({ from, to, target, root: dir }));
  const run = spawnSync(process.execPath, [path.join(root, 'test/desktop-lifecycle.js')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DESKTOP_EXECUTABLE: executable, PLEXUS_UPGRADE_CYCLE: config }
  });
  const evidence = path.join(root, '.artifacts/desktop-upgrade'); fs.mkdirSync(evidence, { recursive: true });
  const cyclePath = path.join(dir, 'result.json');
  const cycle = fs.existsSync(cyclePath) ? JSON.parse(fs.readFileSync(cyclePath, 'utf8')) : null;
  if (run.status === 0 && cycle) await uninstall(target);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { status: run.status === 0 && cycle ? 'pass' : 'fail', platform: process.platform, arch: process.arch,
    os: os.release(), ranAt: new Date().toISOString(), provider: 'demo', signedRelease: false,
    from: { file: path.basename(from), sha256: hash(from) }, to: { file: path.basename(to), sha256: hash(to) }, cycle };
  fs.writeFileSync(path.join(evidence, process.platform + '-' + process.arch + '.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'pass') throw new Error('Installed upgrade drill failed. See .artifacts/desktop-upgrade.');
  console.log('Installed upgrade/reinstall/backup-restore drill passed; demo provider, signatures not qualified.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
// Preserve a failed fixture for diagnosis; a passing run has explicitly quit its services.
if (dir && !process.exitCode) fs.rmSync(dir, { recursive: true, force: true });
})();
