# Distribution and upgrade qualification (#19, #20)

This is an operational procedure and acceptance ledger, not a signed-release receipt.
The product requirements remain in issues #19 and #20. Local checks can supply their
evidence; GitHub Actions is not required.

## Build and verify trusted artifacts

`npm run dist:mac` and `npm run dist:win` remain internal build commands. They do not
establish publisher trust. `npm run release:desktop -- --check` checks configuration;
`npm run release:desktop` builds from a clean tracked checkout without uploading anything.
The latter enables mandatory signing, requires notarization on macOS, verifies native
signatures, and writes hashes and the source commit to `release.json` alongside the files.
It reports installed and upgrade E2E as **not run**; signing is not runtime validation.

Build separately on each OS. Preserve the generated manifest with the exact artifacts.
Do not claim byte-identical reproducibility: the signing timestamps and archive metadata
can differ between builds. The pinned lockfile and recorded source identify the inputs.

### macOS

Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/),
then create a **Developer ID Application** signing identity. Use `CSC_NAME` to select an
identity already in the build user's Keychain, or `CSC_LINK` / `CSC_KEY_PASSWORD` supplied
through a protected build environment. Never commit these values or certificate files.

Prefer a `notarytool` Keychain profile and set `APPLE_KEYCHAIN_PROFILE` to its name. The
builder also supports the complete `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
`APPLE_API_ISSUER` set, or `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.
The release command refuses to build when none is configured. After building it checks
the app using `codesign`, `spctl` and `stapler`, and the DMG signature using `codesign`.

### Windows

Obtain a trusted code-signing identity from a certificate authority; keep the private key
on its supported hardware token/HSM. Make the certificate available in the build user's
Windows certificate store and set `PLEXUS_WINDOWS_CERT_SHA1` to its thumbprint. The release
command selects that identity in electron-builder and uses `Get-AuthenticodeSignature`
to check both the unpacked executable and each produced installer against that thumbprint.

Signing does not promise immediate SmartScreen reputation. The previous installer notes
that said EV signing avoided reputation accumulation are obsolete. See Microsoft's
[current signing comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
The free Microsoft Store signing route applies to MSIX submission; it does not sign this
project's existing NSIS/EXE artifacts. A future Store route needs its own packaging proof.

## Manual update and recoverable reinstall

Until a version pair has passed the installed upgrade drill below, upgrading a customer
installation is **unsupported**. Do not overwrite its data to make a smoke test pass.
No background updater downloads or installs an update.

1. Record the current app version, OS/architecture, Codex version/account mode and the
   current service URL. Keep the prior installer and its trusted signature/hash record.
2. End or explicitly interrupt running tasks. Choose **Quit Plexus**, not window close.
   Verify the execution host and its child processes have exited on the OS. The team
   must see unavailable/interrupted state, never a fabricated completed task.
3. With the application stopped, make a private, complete backup of its user-data folder
   (`~/Library/Application Support/Plexus` on macOS, `%APPDATA%\Plexus` on Windows,
   unless explicitly overridden). Include `Partitions`, the OS-protected broker stores,
   membership checkpoints, `harness`, and `desktop-state.json`. Also back up the configured
   `HARNESS_DATA` directory if it is outside that folder. Do not copy a live SQLite or
   IndexedDB store. Keep the backup local/encrypted and inaccessible to other users.
4. Keep the owner's recovery kit and its key separately, and verify the recovery drill
   before relying on it. A filesystem backup is not a replacement-device recovery kit:
   OS-bound keys generally require the same machine and OS account. Provider credentials
   remain owned by Codex and must not be uploaded with diagnostics or shared with teammates.
5. Verify the new installer's publisher and hash against the release record. Install it
   over the existing application without deleting application data. On macOS replace the
   app bundle; on Windows use the same NSIS installation directory and OS user.
6. Open the application, verify its service and execution host, replay existing encrypted
   history, and inspect the pending-work status. Do not automatically retry uncertain
   commands. Test provider setup and one separately authorized new task. A Codex version
   outside the qualified version must remain unavailable until it is qualified.
7. Reinstall the same build and repeat the history/identity check. Keep the backup until
   the team has verified access, the host's state and the new task.

### Rollback

An older app opening a newer app's stores is **not supported**. To recover from an update,
quit the new app and all its services, retain its data separately for diagnosis, reinstall
the prior trusted app, and restore the *entire matching pre-update backup* on the same OS
account. Never mix individual database, crypto, membership or provider-profile files.

Do not restore a stale authority snapshot into an active shared team after membership,
revocations or owner recovery changed. Existing freshness checks must reject stale state;
use the owner recovery/host activation procedure or a forward repair instead. A rollback
does not undo relay state, revocations, provider token refreshes or project file changes.
Never replay a command merely because the restored local history predates it.

## Required installed drill

For each released old/new version pair and each supported OS/architecture, record:

- Exact source revisions, installer hashes and native signature/notarization results.
- Old version: project/provider setup; two endpoints with readable encrypted history;
  one completed task and one interrupted task awaiting an unapproved file operation.
- New version over the same installation/profile: same endpoint and host identities,
  same existing history, no unapproved file operation replayed, no duplicate execution host,
  and a real-provider browser correction plus delegated approval.
- Same-version reinstall with unchanged history and credentials.
- Restoration of the matching pre-upgrade backup with the old binary, plus rejection of
  stale authority when shared membership changed after the backup.
- Actual process-tree shutdown, native Windows provider execution, and macOS regression.

`test:desktop:install` currently builds/installs/runs/uninstalls and runs lifecycle checks.
Use `-- --installer /absolute/path/to/installer` to test an existing artifact; its source
commit is not inferred from the test checkout. It is **not** the old/new upgrade drill.
`PLEXUS_DESKTOP_COLLABORATION_PROOF=demo` exercises
the two-client flow without claiming real-provider qualification. Real installed testing
requires `PLEXUS_DESKTOP_COLLABORATION_PROOF=1` and `PLEXUS_DESKTOP_CODEX_PROOF=1`.

Run the isolated upgrade drill with:

```sh
npm run test:desktop:upgrade -- --from /absolute/path/to/old-installer --to /absolute/path/to/new-installer
```

It runs an interrupted demo task in the old installed app, captures its authenticated
history, stops the services and backs up both complete stores. It then checks an actual
version change, same-version reinstall, and old-version restoration with that matching
backup. Each launch must retain endpoint/host identity and history without replaying the
unapproved removal. Results include installer SHA-256 hashes in
`.artifacts/desktop-upgrade/<platform>-<arch>.json`. It does not qualify real-provider
credentials, changed shared authority, native signing, or an arbitrary version pair.
Run installer drills sequentially: concurrent macOS mounts of the same DMG can conflict.
On Windows, the helper refuses an existing registered Plexus installation outside the
fixture, because NSIS `/D` alone does not isolate upgrade/uninstall registration.

## Local evidence, 2026-09-12

- macOS arm64 (Darwin 25.6.0): the unsigned 0.1.0 to 0.1.1 demo upgrade,
  reinstall and matching-backup rollback passed. Old artifact SHA-256:
  `547eccad780366ff7a7008fd8903928c7a9f9d71ead7adb65c443e8bf3e2a0fc`;
  new artifact SHA-256:
  `240569f84bd3914680d23544ac6616d9a508ed938d6cfe203bf6dcd068ff437d`.
  Both were built locally from working-tree inputs; these are artifact identities,
  not claims that they correspond to a clean release commit.
- The final 0.1.1 artifact above passed all six local installation checks: artifact
  availability, isolated install, demo desktop/browser collaboration without Node on
  PATH, startup failure/retry, tray lifecycle and explicit process shutdown, and uninstall.
  Desktop and 390px mobile captures were inspected; no production renderer or reference
  baselines were changed. See `.artifacts/desktop-install/darwin-arm64.json` and
  `.artifacts/desktop-collaboration/demo-results.json` for this run's bounded evidence.
- Startup IPC now rejects an unrelated renderer using the real preload while retaining
  legitimate boot recovery. The regression test failed before the guard and passed after.
- The default test-suite stages were exercised locally using Node 22.22.3 and
  `CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`.
  The initial authority group had two local fetch failures; its full 40-test group passed
  with `node --test --test-concurrency=1`. The remaining integration stages passed after
  repairing the standalone approval-expiry fixture's process lifetime (production timers
  remain unchanged). Release-preflight checks passed 4/4. This is a completed local run
  with targeted reruns, not a claim of an uninterrupted green `npm test` invocation.
- The real installed provider attempt configured Codex 0.153.4 with existing ChatGPT
  authentication, but its model turn failed before any file operation. A separate synthetic
  adapter reproduction identified a provider error that the pinned `gpt-5.4-mini` model is
  not supported with ChatGPT. No raw account/provider error text is included in diagnostics.
  Real-provider desktop/browser and upgrade acceptance have **not passed**.
- Native tray opening and dialog clicking are not automated: the lifecycle test invokes
  installed menu handlers and checks the actual dialog plan and resulting process state.
- Neither Windows execution nor trusted macOS/Windows signing has been measured. The
  existing Windows provider gate remains closed. Issues #19 and #20 remain incomplete.

## Current external prerequisites

No trusted signing credentials or Windows test machine were supplied for this work.
Unsigned local tests can proceed. Windows execution and signed release/upgrade acceptance
remain open until measured on those resources; no GitHub billing change is necessary.
