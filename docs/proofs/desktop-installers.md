# Desktop bootstrap builds

Implementation record for
[issue #4](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/4) (P03), under
[the implementation spec](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).

Internal builds only. Public signed distribution is P19's job; what this slice owes is a
build that installs and runs on a clean machine, plus a written list of what signing will
need.

```bash
npm run dist:win     # NSIS installer + portable, x64 and arm64
npm run dist:mac     # dmg + zip, arm64 and x64   (requires macOS - see below)
npm run dist:dir     # unpacked directory, fastest way to check packaging
```

## The blocker that had to be cleared first

The shell used to launch the hub and the execution host with **`node` from PATH**:

```js
function nodeBin() {
  // Use the system node for the hub/runtime so node:sqlite (Node >=22) is available.
  return process.env.HARNESS_NODE || 'node';
}
```

That comment is the whole problem. The hub's store is built on `node:sqlite`, which arrived
in Node 22.5, and Electron 33 bundles **Node 20.18** - so the app could not run its own
services and had to borrow a Node from the user's machine. An installed copy has no
developer checkout, often no terminal, and no guarantee that Node exists at all.

**Electron 44 bundles Node 24.20, which has `node:sqlite`.** With that upgrade the shell
runs both services on `process.execPath` with `ELECTRON_RUN_AS_NODE=1` - its own binary,
inside the package. Nothing on PATH is consulted.

Evidence: launched with `PATH` set to `C:\WINDOWS\system32;C:\WINDOWS` only - no Node
anywhere on it - the hub starts, the execution host registers, and `/api/health` reports
`{"ok":true,"runtimes":1,"clients":2}`.

## Supported targets

| Platform | Targets | Arch | Built here |
| --- | --- | --- | --- |
| Windows 10/11 | `nsis` installer, `portable` | x64, arm64 (nsis); x64 (portable) | yes |
| macOS 13+ (Ventura) | `dmg`, `zip` | arm64, x64 | **no - needs a Mac** |
| Linux | `AppImage` | x64 | not exercised |

macOS 13 is Electron 44's floor, not a preference. `Electron.app/Contents/Info.plist` in
`electron-v44.2.0-darwin-arm64.zip` and `-x64.zip` declares `LSMinimumSystemVersion 13.0`,
and `build.mac` sets no `minimumSystemVersion`, so the packaged app inherits it. This row
read `macOS 11+` until it was corrected: 11.0 is what Electron 33 declared, and the number
did not follow the upgrade (Electron 43 declares 12.0, 44 declares 13.0).

**Prerequisites for a user:** none beyond the OS. No Node, no terminal, no checkout. The
runtime shells out to a system shell only when an *agent* runs a command, and to `codex` or
`claude` only if the user selects those providers - those are the user's own tools, not
install prerequisites.

**Prerequisites for a builder:** Node 22.5+ and `npm ci`, then `node
node_modules/electron/install.js`. That second step is not optional on npm 11: install
scripts are blocked by default, so `npm ci` alone leaves `node_modules/electron` with no
binary in it and every desktop test fails at launch with nothing to run. macOS artifacts
must be built on macOS; electron-builder cannot produce a signed, notarizable `.app` from
Windows, and notarization requires Apple's toolchain. That row above is `no` for a reason,
not an oversight, and it is the one acceptance criterion this machine cannot execute.

## What packaging had to fix

- **The service `cwd` pointed inside the asar.** `spawn(..., { cwd: ROOT })` is fine in a
  checkout, where ROOT is a directory. Packaged, ROOT is `app.asar` - a *file* - and the OS
  cannot chdir into it, so both services failed to start before producing a single line of
  output. Scripts still resolve through ROOT, because Electron's fs reads inside the asar
  happily; only `cwd` has to be a real directory. This is the bug that made the first
  packaged build open a window and do nothing.
- **Spawn errors were unhandled.** No `child.on('error')`, so a spawn that fails outright
  threw an unhandled event instead of reporting itself.
- **`ROOT` was a source-tree path.** `path.join(__dirname, '..', '..')` is right in a
  checkout and wrong in an asar. It is now `app.getAppPath()` when packaged and the
  file-relative path only in development. (`getAppPath()` alone is not enough: launched as
  `electron apps/desktop/main.js` it returns the *script's* directory, which is how the
  first packaged-path attempt failed.)
- **A remote hub disabled the local execution host.** `HUB_HTTP_URL` skipped the whole
  `if (!httpUrl)` block, which spawned the runtime as well as the hub - so configuring a
  remote team service left the app connected with nothing able to execute anything. The
  runtime now always starts; only the hub is conditional. This is the second acceptance
  criterion, and it was broken.
- **`HARNESS_PROJECTS` split on `':'`**, which tears every Windows path apart at its drive
  letter. It splits on `path.delimiter` now.
- **Failures were invisible.** `boot()` rejecting called `app.quit()` after a
  `console.error` no one would ever see, so a startup failure looked like the app simply
  not opening.

## Evidence

Packaged run (`dist/installers/win-unpacked/Plexus.exe`, isolated `--user-data-dir`), from
the app's own log:

```
--- started 2026-09-06T03:32:41Z · electron 44.2.0 · node 24.20.0 · packaged=true ---
[boot] hub working — Starting the local team service…
[hub] listening on http://127.0.0.1:7820
[boot] hub ready — Local team service running
[boot] runtime working — Starting this machine as an execution host…
[runtime] registered runtime rt_01146523256a42d3 (tkala@Kalai-Laptop) with hub
[boot] runtime ready — This machine is available to the team
[boot] ui working — Opening the workspace…
```

`/api/health` then reports `{"ok":true,"runtimes":1,"clients":2}`.

Artifacts from `npm run dist:win`, rebuilt from `80217ad` on 2026-09-07 and hashed:

| File | What it is | Size | SHA-256 |
| --- | --- | --- | --- |
| `Plexus-0.1.0-win-x64-setup.exe` | x64 NSIS installer | 107 MB | `535c2b7c0b2c7116c3dc38ca3a3c36cb49382bb0118ef9ab60103f8fa2f733bd` |
| `Plexus-0.1.0-win-arm64-setup.exe` | arm64 NSIS installer | 101 MB | `dab3732e41cbae369958bc4eaa8c70c00865861dbc897acf1c176d04461f6903` |
| `Plexus-0.1.0-win-setup.exe` | **both arches in one installer** | 209 MB | `668e4da0a91a5c740d841acd40b7e04c3d69764c3e00656e621ba8a5b02226a0` |
| `Plexus-0.1.0-win-x64-portable.exe` | x64 portable | 107 MB | `9e1c670d4da2da3620680230d6e62f239912b0c6fa995fdc40dfeae4313a260c` |
| `*.blockmap` | update metadata, one per NSIS installer | | |

Read that table before handing anyone a build. `npm run dist:win` emits **four** installers,
not three: declaring `nsis` for `x64` and `arm64` makes electron-builder produce a per-arch
installer for each *and* a combined one carrying both.

**The artifact to hand out is `Plexus-0.1.0-win-setup.exe`, the combined one.** It installs
the right architecture on either machine, so nobody has to know what they are running before
they download, and there is no way to hand somebody the wrong file. That failure has already
happened once on this slice, when a naming collision meant every "installer" was actually the
portable binary - the cost of getting it wrong is not hypothetical. The price is size: 209 MB
against 107 MB, because it carries both builds.

The per-arch installers stay in the output for anyone who needs a smaller download and knows
which they want; they are not what an internal tester is given. Only the x64 setup has been
installed and exercised by hand, and the CI proof installs the per-arch build for the runner's
own architecture - so the combined installer is assembled from exercised parts but has not
itself been installed end to end. That is the one gap in this decision, and it closes the
first time somebody installs it on a real machine.

This is a distribution choice, not a finding. Reverse it by naming a different row here. This table previously listed three files and a `latest.yml`; the rebuild
produced no `latest.yml` at all.

The hashes name these exact files. They are not a claim of a deterministic build -
electron-builder stamps build time into its output, so the same tree built again hashes
differently. Reproducible here means the command reproduces the artifact set, not the bytes.

**A target-name collision hid the installer.** `artifactName` did not distinguish target
type, so nsis and portable both wrote `Plexus-0.1.0-win-x64.exe` and the second overwrote
the first - every "installer" produced by the first build was actually the portable binary,
which is why installing it did nothing. Each target names its own artifact now. This was
found by trying to install the thing rather than by trusting that a file with the right
name was the right file.

### Installation evidence (Windows x64)

```
Plexus-0.1.0-win-x64-setup.exe /S /D=<dir>     installer exit code: 0
installed Plexus.exe: True
```

Launched from the installed location with `PATH` reduced to `C:\WINDOWS\system32;C:\WINDOWS`:

```
node on PATH: False
--- started ... electron 44.2.0 · node 24.20.0 · packaged=true ---
[boot] hub ready — Local team service running
[runtime] registered runtime rt_18900f468622dfec (tkala@Kalai-Laptop) with hub
[boot] runtime ready — This machine is available to the team
```

`/api/health` reports `{"ok":true,"runtimes":1,"clients":2}`. The bundled uninstaller then
removes the install directory and its Start Menu shortcut cleanly (exit code 0).

### Failure path

Pointed at a team service that is not running, the app does not quit silently:

```
[boot] hub failed — Could not reach the team service at http://127.0.0.1:7999
                    (fetch failed). Check the address and your network.
```

The window stays up with that message, **Try again** and **Open data folder**.

## Readiness and actionable failures

The window now opens *before* the services do and shows three steps - team service,
execution host, workspace - each moving through working / ready / failed. Readiness means
the execution host has actually registered (`/api/health` reporting `runtimes > 0`), not
that a window painted.

A failure keeps the window up, shows the last lines of that service's own output, and
offers **Try again** and **Open data folder**. Everything the shell prints also goes to
`<userData>/logs/desktop.log`, because an installed app has no console - without it a
startup failure is invisible to the user and unreportable to us. That log is how the two
packaging bugs above were found. The messages name what to do: an unreachable
remote hub says which address failed and to check the network; a hub that died shows its
own stderr.

## Tested revisions and environments

| | |
| --- | --- |
| Revision under test | `80217ad` (`main`), which contains the #32 merge `6aed137` |
| Machine | Windows 11 Home, build 10.0.26200.9168, x64 - the machine that built the artifacts |
| Toolchain | Node 24.20.0, npm 11.19.0, Electron 44.2.0, electron-builder 26.15.3 |
| Date | 2026-09-07 |

Re-run on that revision and machine:

| What was run | Result |
| --- | --- |
| `npm run dist:win` | exit 0; the four installers above |
| `node test/desktop-bootstrap.js` | 3/3 pass - a failed start stays visible with a working data-folder action; retry reaches the remote hub and registers this exact local host with no Node on `PATH`; an exited runtime holds the error screen and recovers after repair |
| `node test/desktop-smoke.js` with `DESKTOP_EXECUTABLE` set to the packaged `win-unpacked/Plexus.exe` and `PATH` reduced to `%SystemRoot%\system32;%SystemRoot%` | 11/11 pass, including a native folder dialog authorizing a project on the local host and that authorization surviving a runtime restart |

The packaged run matters because #32 recorded project selection as the one part of criterion
3 that could not be driven in a packaged build. It can be, and it passes; `ce86da5` added the
harness that does it. The earlier install/uninstall evidence above was produced on 2026-09-06
during #32 and has not been re-executed here.

Neither test runs in CI. `npm test` covers protocol, unit, team, codex and e2e; the two
desktop tests are manual, so nothing catches a regression in this slice.

**Not tested, on any revision: macOS.** No `dmg` or `zip` has been built and the shell has
never been launched on a Mac. `docs/proofs/e2ee-platform-results.json` records a packaged
macOS run at `b3873b8`, but `scripts/e2ee-platform-proof.js` builds it with
`--config.extraMetadata.main=packages/e2ee/desktop-proof-main.js` - a different entry point.
It shows the macOS packaging pipeline works; it does not exercise `apps/desktop/main.js`, the
hub and execution host it starts, or installation from a `dmg`.

## Signing and notarization: what P19 will need

Not required for this internal slice, but the provisioning has a lead time, so it is
identified now:

**macOS**
- An Apple Developer Program membership, and a *Developer ID Application* certificate
  (`.p12`) plus its password, supplied to electron-builder as `CSC_LINK` / `CSC_KEY_PASSWORD`.
- An app-specific password or an App Store Connect API key (issuer id + key id + `.p8`) for
  `notarytool`.
- The hardened runtime is already enabled, with `build/entitlements.mac.plist` requesting
  `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` and
  `inherit`. These are needed because the shell spawns its own services from the bundled
  Electron binary and the execution host runs the user's tools; each one should be
  challenged during the security review rather than assumed.
- A build machine running macOS.

**Windows**
- An EV or OV code-signing certificate. OV signing still accumulates SmartScreen reputation
  slowly; EV does not. Supplied as `CSC_LINK` / `CSC_KEY_PASSWORD`, or via a cloud HSM
  signer, since most CAs no longer issue exportable OV keys.
- Unsigned NSIS installers will show a SmartScreen warning. That is expected for internal
  builds and must not ship to pilots.

**Both:** an artifact-hosting decision and an update channel. `--publish never` is set
deliberately so no build can auto-publish before that decision exists.

## Brand

The window, the installer and the startup screen all use the Plexus identity: `build/icon.png`
is the 1024px app-icon master from the brand kit, and the boot screen uses the brand palette
and Outfit, loaded from the same bundled font files the web UI uses.

## Acceptance status

| Criterion | Status |
| --- | --- |
| 1 - install and launch on clean macOS and Windows; no system Node, terminal or source-tree dependency | **Partial.** The dependency half is proved on Windows, including from an installed copy with no Node on PATH. Neither platform has been exercised on a *clean* machine, and macOS not at all. |
| 2 - readiness, actionable failures, remote hub still registers the local host | **Met.** Both paths tested. |
| 3 - packaged resources, platform paths, project selection, recorded targets and prerequisites | **Met on Windows.** Packaged resources and folder authorization pass the Electron-driven smoke test; the native dialog return is stubbed to a real temporary project. macOS remains untested. |
| 4 - reproducible artifacts, installation evidence, signing provisioning identified | **Met for Windows.** Artifacts reproduce from `npm run dist:win`, install, launch and uninstall; provisioning is written up. No macOS artifact. |

## Not done

- **No macOS artifact.** Requires a Mac; recorded above rather than faked.
- **No clean-machine install test.** This machine is a developer box. Installing here shows
  the installer works; it does not show it works on a machine that has never had the
  toolchain. That needs a fresh Windows VM and a fresh Mac.
- **No auto-update.** Out of scope for an internal slice and gated on the hosting decision.

## Merge verification and edge-case scan (2026-09-06)

Integrated with the current private-team and Codex-proof branches. Kept host-local
folder authorization, canonical pairing codes, and the shared `apps/web` renderer.
The exact local runtime now reports readiness over parent/child IPC after its hub
handshake. An unpaired host says ?ready to pair?; another online host cannot make
this local host appear ready. A runtime startup failure retains the boot screen.
Retry waits for child shutdown and coalesces concurrent calls. Initial boot waits
for the status listener to load; health requests have bounded network timeouts.
A failed log stream does not crash startup, and reduced-motion preferences stop
its progress animation.

Validation: full `npm test` (protocol, 16 unit tests, 68 boundary checks, 9 Codex
control checks, multiplayer browser E2E); `npm run check:design`; desktop smoke
from source and from the Windows x64 packaged executable with system Node absent
from PATH. Packaged smoke covers pairing, consumed codes, wrong-host refusal,
folder authorization persistence/restart, and a real demo file write.
`npm run test:desktop-bootstrap` covers unavailable remote hub, data-folder action,
concurrent retries, the exact local unpaired host, exited runtime, and repair/retry.
The dormant Codex approval proof reports the production isolation blocker instead
of waiting for a command that cannot be authorized.

`npm audit` and `npm audit --omit=dev` report zero vulnerabilities. This is a
registry dependency scan, not a proof that all application defects are absent.
Four design-checker tests fail on Windows exactly as on unchanged main (symlink
permissions and path assertions); the GitHub Linux workflow passes.

Visual contract: setup screen uses `setup` and then `shell`; startup is the
existing compact desktop bootstrap surface before a workspace exists. It reuses
the bundled Outfit font and Plexus palette; the live setup remains in `apps/web`.
Compared startup, failure and setup screenshots at 1487?1058 and 390?844 with
`docs/design/plexus/design/qa/setup-desktop.png`. No horizontal clipping found.
The compact bootstrap and existing team gate intentionally retain their layout;
this merge does not migrate them to the prototype's full workspace shell.
Evidence is under `.artifacts/desktop-bootstrap/`; selected captures are committed
under `docs/proofs/desktop-merge-checks/`. Accepted reference baselines are unchanged.

macOS builds, clean-machine installations, signing/notarization, and production
CLI isolation/approval proof remain release gates; merging this integration does
not assert they are complete.

Screenshot inspection also found the demo verifying a file with a directory-only
listing operation. It now reads the created file through the workspace API and
reports a failed/declined write without claiming creation succeeded.
