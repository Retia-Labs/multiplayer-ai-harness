'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(path.basename(file) + ' failed: ' + (result.error?.code || result.status));
  return result.stdout;
}

// The caller must stop the installed app before replacing its binaries. This
// changes only installation files; application data is deliberately untouched.
function install(installer, target) {
  if (process.platform === 'win32') {
    assertWindowsTarget(target);
    if (!installer.toLowerCase().endsWith('.exe')) throw new Error('Expected an NSIS .exe installer.');
    command(installer, ['/S', '/D=' + target]);
    const executable = path.join(target, 'Plexus.exe');
    if (!fs.existsSync(executable)) throw new Error('Installer did not produce Plexus.exe.');
    return executable;
  }
  if (process.platform !== 'darwin' || !installer.endsWith('.dmg')) throw new Error('Expected a macOS .dmg installer.');
  const output = command('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountrandom', os.tmpdir(), installer]);
  const mount = output.split('\n').map(line => line.split('\t').pop().trim()).filter(line => line.startsWith('/')).pop();
  if (!mount) throw new Error('Installer mount point missing.');
  try {
    const bundles = fs.readdirSync(mount).filter(file => file.endsWith('.app'));
    if (bundles.length !== 1 || bundles[0] !== 'Plexus.app') throw new Error('Expected one Plexus.app bundle.');
    fs.mkdirSync(target, { recursive: true });
    // Replacement must not leave files removed by the newer version behind.
    const destination = path.join(target, 'Plexus.app');
    fs.rmSync(destination, { recursive: true, force: true });
    command('ditto', [path.join(mount, bundles[0]), destination]);
    return path.join(destination, 'Contents/MacOS/Plexus');
  } finally { command('hdiutil', ['detach', mount, '-force']); }
}

function assertWindowsTarget(target) {
  if (process.platform !== 'win32') return;
  // NSIS /D changes a destination, not the registered application identity.
  // Never let a test upgrade/uninstall an existing customer installation.
  const source = String.raw`
    $ErrorActionPreference='Stop'
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
      foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
        try {
          $root=$base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
          if (!$root) { continue }
          try {
            foreach ($name in $root.GetSubKeyNames()) {
              $entry=$root.OpenSubKey($name)
              if (!$entry) { throw 'Uninstall registration unreadable' }
              try {
                if ($entry.GetValue('DisplayName') -notlike 'Plexus*') { continue }
                $uninstall=$entry.GetValue('UninstallString')
                if ($uninstall -notmatch '^"([^"]+)"(?:\s.*)?$') { throw 'Unrecognized Plexus registration' }
                $file=[IO.Path]::GetFullPath($Matches[1])
                if ([IO.Path]::GetFileName($file) -ne 'Uninstall Plexus.exe' -or
                    [IO.Path]::GetDirectoryName($file).TrimEnd('\') -ne [IO.Path]::GetFullPath($env:PLEXUS_TEST_INSTALL).TrimEnd('\')) {
                  throw 'Existing Plexus installation: use a disposable Windows VM'
                }
              } finally { $entry.Dispose() }
            }
          } finally { $root.Dispose() }
        } finally { $base.Dispose() }
      }
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { encoding: 'utf8', env: { ...process.env, PLEXUS_TEST_INSTALL: target } });
  if (result.error || result.status !== 0) throw new Error('Cannot safely test installation: use a disposable Windows VM with no existing Plexus installation.');
}

async function uninstall(target) {
  if (process.platform === 'win32') {
    assertWindowsTarget(target);
    const file = fs.readdirSync(target).find(name => /^Uninstall .*\.exe$/.test(name));
    if (!file) throw new Error('Installed uninstaller missing.');
    command(path.join(target, file), ['/S']);
    for (let n = 0; n < 60 && fs.existsSync(target); n++) await new Promise(resolve => setTimeout(resolve, 500));
    if (fs.existsSync(target)) throw new Error('Windows uninstall did not finish.');
  } else fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { install, uninstall, assertWindowsTarget };
