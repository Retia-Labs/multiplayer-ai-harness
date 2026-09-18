# Hosted alpha setup

Status (2026-09-19): DigitalOcean server provisioned, source installed, DNS and public HTTPS certificate verified. The authenticated relay is running. Real GitHub consent/callback, logout/relogin, team creation and browser-session survival across a service restart are verified; customer-alpha qualification remains incomplete. Issues #75, #76 and #70 remain open until their full acceptance checks pass.

## Service

The approved host is a separate DigitalOcean Droplet named `plexus-alpha` in Singapore: Ubuntu 24.04, 1 vCPU, 1 GB RAM and 25 GB persistent disk. The dashboard quotes US$6/month base, approximately US$6.54 with Singapore GST, before excess usage. Active promotional credits were not verified. The existing landing-page Droplets are not part of this deployment.

Deployment configuration is in `deploy/digitalocean/`. Node v22.23.2 runs the relay under the `plexus` system account. Source releases live under `/opt/plexus/releases/`, with `/opt/plexus/current` pointing to the selected release. The current installed source is `046b020` from PR #77, not main. Install production dependencies with `npm ci --omit=dev --ignore-scripts`.

SQLite and application-aware snapshots stay under `/var/lib/plexus`, owned by `plexus` with mode 0700. The systemd unit permits writes there and binds the hub only to `127.0.0.1:7777`. Caddy handles public HTTPS and WebSocket proxying. UFW permits SSH and TCP ports 80/443; port 7777 is not public. `/etc/plexus/relay.env` is root-owned mode 0600. Keep secrets out of the repository, shell history and service logs.

Cloudflare has a DNS-only A record for `app.tryplexus.dev` pointing to the new Droplet at `168.144.34.212`. Caddy obtains and renews the origin's public certificate. Apex and `www` landing-page records are unchanged. This deployment does not rely on Cloudflare's HTTP proxy or change the zone's TLS settings.

Deploys are manual; GitHub Actions remains disabled. The previous `render.yaml` is an unused alternative; no Render service was purchased. This remains a single-instance relay, so restarts interrupt connections and require tested reconnect. Reassess capacity from measured invited-alpha usage.

### Service operations

After the operator supplies real OAuth credentials and the account allowlist:

```sh
sudo systemctl enable --now plexus
curl --fail http://127.0.0.1:7777/api/health
sudo systemctl status plexus --no-pager
```

Check public `/api/health` and `/api/auth/config` over verified HTTPS, then perform real browser and desktop login. `systemctl restart plexus` preserves the database but cancels pending login exchanges. Inspect fixed error codes without collecting credentials or customer content.

Install `plexus-snapshot.service` and `plexus-snapshot.timer` in `/etc/systemd/system/`, reload systemd, and enable the timer with `systemctl enable --now plexus-snapshot.timer`. It creates a daily ciphertext-only snapshot and prunes snapshots older than seven days, even when the relay is stopped. It skips until the database exists. Check failures using `systemctl status plexus-snapshot.service` and check the next run with `systemctl list-timers plexus-snapshot.timer`. These local snapshots do not protect against loss of the Droplet; they never restore identities, sessions or grants, and off-server recovery still needs qualification.

For an update, unpack the reviewed exact commit into a new release directory, install production dependencies, run relevant checks, then stop the relay, switch `/opt/plexus/current`, and start it. Keep the existing database in place. A code rollback is safe only if its schema and protocol are compatible with the current database; never roll the database back to an old disk image. Use the deletion-aware snapshot and restore procedure in `pilot-operations.md`. Off-server recovery and operational qualification remain release gates; a persistent disk alone is not a backup.

### Observed installation checks

On the new Ubuntu server, all 12 `test/hosted-auth.js` tests and `test/protocol-smoke.js` passed. `test/pilot-operations.js` passed 11 tests with its Windows-only test skipped: these cover deletion tombstones, restore against current grants, snapshot expiry and diagnostic/measurement content boundaries in isolated fixtures. They do not establish an off-server production recovery drill. The production-only dependency install reported zero known vulnerabilities. Public DNS resolved to the new server and curl verified its HTTPS certificate. Public `/api/health` returns 200 and `/api/auth/config` reports GitHub mode. A single oversized unauthenticated message sent over public WSS closed with code 1009 while health remained 200, verifying the relay-crash regression fix through Caddy. Real GitHub consent/callback, private team creation, logout followed by reload, repeat login and session survival across a relay restart were exercised in Chrome at the public origin. The daily snapshot job returned success against the live database (no collaborative task content yet). An isolated installed Mac app subsequently passed production desktop authorization, session persistence after restart, OS-protected credential checks and logout revocation; see `docs/proofs/hosted-authentication.md`. These checks do not prove the OS browser opener, live collaboration, off-server disaster recovery, signed distribution or customer-alpha readiness.

## Identity and domain

1. Register an organization-owned GitHub OAuth app named **Plexus Alpha**. Homepage: `https://app.tryplexus.dev`. Exact redirect: `https://app.tryplexus.dev/api/auth/callback`. No wildcard redirects or GitHub device flow needed. Keep expiring GitHub tokens enabled; Plexus does not store provider tokens or refresh tokens.
2. Put its client ID and secret into `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `/etc/plexus/relay.env`, using a private terminal prompt over SSH. Never commit them, paste them in an issue, or put them in the desktop build. Credential creation/entry is an account-owner step.
3. Set `PLEXUS_ALPHA_GITHUB_IDS` to comma-separated immutable numeric GitHub user IDs. This admits accounts to the alpha, not to a team or project. Remove an ID and restart to end that account's hosted access; persisted sessions are checked against the active allowlist.
4. Verify the Cloudflare `app` record points to the Plexus Droplet and Caddy serves a valid certificate. Verify HTTPS/WSS before sign-in. Do not expose an unconfigured name-login service.
5. Confirm `PLEXUS_PUBLIC_ORIGIN=https://app.tryplexus.dev`, `PLEXUS_AUTH_MODE=github`, `NODE_ENV=production`, and a persistent `HUB_DB`. Missing credentials/allowlist must prevent startup.

The Render GitHub deployment integration and the Plexus GitHub sign-in app are different applications. Repository-only access for Render does not configure user sign-in or enable GitHub Actions.

## Qualification before invitations

- Real GitHub login/cancel/retry, logout and expired session at the production domain. No name-only access over HTTP or WebSocket.
- Signed packaged desktop opens the system browser, receives its own approved session, retains it through restart, and signs out. Verify actual OS-protected credential storage.
- A second allowlisted account signs in, receives an owner-created invitation by verified email, enrolls and confirms its endpoint, then opens a private task link. Login alone must not expose history.
- Real supported provider task, attributed steering, scoped approval, handoff, disconnect/reconnect and replay from separate physical machines (#69).
- Restart the relay and verify persistent account/team/content state. Exercise deletion-aware backup/restore and revocation with `pilot-operations.md`; do not treat an old disk snapshot as a qualified restore.
- Check hosted diagnostics/health reveal no content or credentials. Confirm support and retention behavior before inviting customers.

Signed downloads/updates (#20), Windows (#19), independent privacy/control review (#25), live hosting (#70) and complete onboarding (#76) remain separate release gates. No unsigned development artifact should be presented as the early-access download.


### Invited Mac candidate — 2026-09-19

Source `bbe643c` is deployed with hosted invitation history and onboarding fixes. Server-side hosted authentication (12 tests) and protocol smoke passed before switching the release symlink. Public HTTPS health/auth configuration succeeded and the served `app.js` SHA-256 matched the checkout.

The unnotarized Apple Silicon candidate is `Plexus-0.2.0-alpha.1-mac-arm64-unnotarized.dmg` (130651850 bytes), SHA-256 `e5317610d3049b8653ae5329eaf43030240d6d1b9a919d32e8b4f0575e5c9a9e`. Its manifest records application source `bbe643c989df32b69463aa8de5848743d203ee7e`. Packaging inputs were committed; unrelated user documentation changes were excluded by the package file list.

The exact DMG was mounted and copied into `.artifacts/invited-alpha-installed/` without replacing the user's application. `DESKTOP_EXECUTABLE` now lets the native hosted-auth test target that installed binary. The isolated HTTPS fixture journey passed Electron authorization, protected token storage, restart, logout and invitation UI checks; the installed bootstrap test passed startup diagnostics, failed-start/retry and runtime-repair paths without Node on PATH. The first native run timed out capturing a hidden window; leaving the test window visible resolved it. These tests do not qualify downloaded Gatekeeper handling, production sign-in for this exact version, upgrades or physical two-person collaboration.

Installation guidance is in `invited-mac-alpha.md`. The signed release command is unchanged. The candidate is intended for draft prerelease storage until the remaining distribution checks pass.


### Hosted account upgrade qualification — 2026-09-19

The native HTTPS journey now accepts paired `PLEXUS_AUTH_UPGRADE_FROM` / `PLEXUS_AUTH_UPGRADE_TO` installer paths. It installs the older DMG into a disposable directory, authorizes the installed app, quits it, replaces its application bundle with the newer DMG, then reopens with the same profile and runtime-data directory. Both paths must be supplied; evidence is written only after the final logout check passes.

Observed upgrade: internal `0.1.2` (SHA-256 `7f91bdacb15c6630d23e8464b4ce833794829cdeb0814a2e37fb019f013776e1`) to `0.2.0-alpha.1` (SHA-256 `e5317610d3049b8653ae5329eaf43030240d6d1b9a919d32e8b4f0575e5c9a9e`). The application version changed, account session and encrypted endpoint fingerprint were preserved, and logout removed the credential. The complete hosted-browser/native journey passed. Generated evidence: `.artifacts/hosted-auth/installed-upgrade.json`.

This proves account/device continuity across this exact replacement, using a local HTTPS service and fixture GitHub identity. It does not prove provider/task continuity, production upgrade behavior, browser download quarantine handling or Apple notarization. The draft release remains unpublished.

### Authenticated installer delivery

Set `PLEXUS_DESKTOP_RELEASE_DIR` to an immutable, operator-owned directory containing `release.json` and its single unnotarized Apple Silicon DMG. The relay validates version/platform/signing labels, exact filename, byte count and SHA-256 before starting. Never place credentials or unrelated files there. An absent setting leaves downloads unavailable; invalid configured bytes stop startup rather than advertise a corrupt installer.

`GET /api/desktop-release` returns version/architecture/checksum metadata to an authenticated account. `GET /api/desktop-download` streams only that selected artifact; request parameters cannot choose filesystem paths. Both reject unauthenticated requests and hosted legacy/URL/revoked tokens. Browser account entry and workspace setup share a download card with the unnotarized notice, Apple guidance, checksum disclosure and failure/retry handling. Desktop clients do not show this browser download card.

Checks: 16 hosted-auth/download tests passed; the hosted browser journey downloaded and verified fixture bytes, exercised unavailable/failure/retry states and passed existing authentication/invitation checks. Inspected `download-desktop.png` (1487×1058) and the focused `download-mobile.png` capture (390×844 viewport) under `.artifacts/hosted-auth/`. Reuses the setup/account card, buttons and shared tokens; checksum wraps without clipping. This is implementation evidence, not proof that a real configured artifact has been downloaded through production.


### Live download deployment — 2026-09-19

Service revision `046b020` is live. `/opt/plexus/downloads/0.2.0-alpha.1/` holds the root-owned candidate DMG and build manifest, with the release directory configured in the existing private service environment. The actual file passed startup checksum verification; all 16 hosted-auth/download tests passed on Linux before deployment. Public health returned success and an anonymous download returned HTTP 401. Signed-in Chrome displayed version `0.2.0-alpha.1`, Apple Silicon, 125 MB and the unnotarized notice.

The GitHub draft asset was downloaded back through `gh` and passed `SHA256SUMS`, proving its bytes match the tested DMG. This CLI download does not prove browser quarantine or Gatekeeper behavior.

Clicking the live download in controlled Chrome returned `ERR_BLOCKED_BY_CLIENT` (“This page has been blocked by Chrome”). No browser protection was bypassed. The user was asked to try the same download manually, and the Plexus app was left open. The cause and real Chrome download/installation qualification remain unresolved. The GitHub prerelease is still a draft; the service download is restricted to authenticated alpha accounts.
