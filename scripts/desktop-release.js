'use strict';
// Local release qualification. Building an internal installer is not publishing a
// signed release: this entry point requires credentials and verifies the result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function prerequisites(platform, env) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Build on macOS or Windows.');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('Signing is disabled by CSC_IDENTITY_AUTO_DISCOVERY.');
  if (platform === 'darwin') {
    if (!env.CSC_NAME && !env.CSC_LINK) throw new Error('Configure a Developer ID Application identity with CSC_NAME or CSC_LINK.');
    const notarization = env.APPLE_KEYCHAIN_PROFILE ||
      (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
      (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
    if (!notarization) throw new Error('Configure notarization with APPLE_KEYCHAIN_PROFILE, Apple API credentials, or Apple ID credentials.');
  } else if (!env.PLEXUS_WINDOWS_CERT_SHA1) {
    throw new Error('Configure PLEXUS_WINDOWS_CERT_SHA1 for a trusted certificate in the Windows certificate store (with its token/HSM available).');
  } else if (!/^[a-fA-F0-9]{40}$/.test(env.PLEXUS_WINDOWS_CERT_SHA1)) {
    throw new Error('PLEXUS_WINDOWS_CERT_SHA1 must be the 40-character certificate thumbprint.');
  }
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(path.basename(file) + ' failed. ' + (result.error?.code || 'Exit ' + result.status));
  return result.stdout?.trim();
}

function verifyWindows(file, thumbprint) {
  // Paths travel in the environment, never as interpolated PowerShell source.
  const source = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:PLEXUS_VERIFY_FILE; " +
    "if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne $env:PLEXUS_VERIFY_CERT) { throw 'Untrusted signature or wrong publisher' }";
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { env: { ...process.env, PLEXUS_VERIFY_FILE: file, PLEXUS_VERIFY_CERT: thumbprint } });
}

function main(argv = process.argv.slice(2)) {
  if (argv.some(arg => arg !== '--check')) throw new Error('Usage: node scripts/desktop-release.js [--check]');
  prerequisites(process.platform, process.env);
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('Commit tracked changes before qualifying a release.');
  const untrackedInputs = () => run('git', ['ls-files', '--others', '--', 'apps', 'packages', 'build']);
  if (untrackedInputs()) throw new Error('Remove or commit untracked packaged inputs before qualifying a release.');
  if (argv.includes('--check')) { console.log('Release configuration is present; signing and notarization have not yet been exercised.'); return; }
  const pkg = require('../package.json');
  const commit = run('git', ['rev-parse', 'HEAD']);
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'plexus-release-'));
  const mac = process.platform === 'darwin';
  const args = [path.join(root, 'node_modules/electron-builder/cli.js'), mac ? '--mac' : '--win',
    '--publish', 'never', '--config.forceCodeSigning=true', '--config.directories.output=' + output];
  if (mac) args.push('--config.mac.notarize=true', '--config.dmg.sign=true');
  else args.push('--config.win.signtoolOptions.certificateSha1=' + process.env.PLEXUS_WINDOWS_CERT_SHA1);
  run(process.execPath, args, { stdio: 'inherit' });
  const artifacts = fs.readdirSync(output).filter(file => /\.(dmg|zip|exe)$/.test(file));
  if (!artifacts.length) throw new Error('No release artifacts were produced.');
  let applications = 0;
  for (const dir of fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const executable = path.join(output, dir.name, mac ? 'Plexus.app' : 'Plexus.exe');
    if (!fs.existsSync(executable)) continue;
    applications++;
    if (mac) {
      run('codesign', ['--verify', '--deep', '--strict', executable]);
      run('spctl', ['--assess', '--type', 'execute', executable]);
      run('xcrun', ['stapler', 'validate', executable]);
    } else verifyWindows(executable, process.env.PLEXUS_WINDOWS_CERT_SHA1);
  }
  if (!applications) throw new Error('No packaged application was available for native signature verification.');
  for (const file of artifacts) {
    const absolute = path.join(output, file);
    if (!mac) verifyWindows(absolute, process.env.PLEXUS_WINDOWS_CERT_SHA1);
    else if (file.endsWith('.dmg')) run('codesign', ['--verify', '--strict', absolute]);
  }
  if (run('git', ['rev-parse', 'HEAD']) !== commit || run('git', ['status', '--porcelain', '--untracked-files=no']) || untrackedInputs()) {
    throw new Error('Source changed during the release build. Rebuild from a stable commit.');
  }
  const manifest = { version: pkg.version, commit, platform: process.platform, builtAt: new Date().toISOString(),
    signing: 'verified', notarization: mac ? 'verified' : 'not-applicable',
    // This command establishes distribution trust, not runtime or upgrade acceptance.
    installedE2E: 'not-run', upgradeE2E: 'not-run',
    artifacts: artifacts.map(file => ({ file, bytes: fs.statSync(path.join(output, file)).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex') })) };
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Verified signing; artifacts and release.json: ' + output);
  console.log('Nothing was uploaded. Run installed and upgrade E2E against these exact artifacts before distribution.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('RELEASE BLOCKED: ' + error.message); process.exitCode = 1; }
}
module.exports = { prerequisites };
