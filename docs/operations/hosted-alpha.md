# Hosted alpha setup

Status (2026-09-19): DigitalOcean server provisioned, source installed, DNS and public HTTPS certificate verified. The relay is stopped pending OAuth credentials; real sign-in and customer-alpha qualification are not complete. Issues #75, #76 and #70 remain open until their full acceptance checks pass.

## Service

The approved host is a separate DigitalOcean Droplet named `plexus-alpha` in Singapore: Ubuntu 24.04, 1 vCPU, 1 GB RAM and 25 GB persistent disk. The dashboard quotes US$6/month base, approximately US$6.54 with Singapore GST, before excess usage. Active promotional credits were not verified. The existing landing-page Droplets are not part of this deployment.

Deployment configuration is in `deploy/digitalocean/`. Node v22.23.2 runs the relay under the `plexus` system account. Source releases live under `/opt/plexus/releases/`, with `/opt/plexus/current` pointing to the selected release. The current installed source is `db32f80cbf8d84fecbda061e29128fbf023fe10f` from PR #77, not main. Install production dependencies with `npm ci --omit=dev --ignore-scripts`.

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

For an update, unpack the reviewed exact commit into a new release directory, install production dependencies, run relevant checks, then stop the relay, switch `/opt/plexus/current`, and start it. Keep the existing database in place. A code rollback is safe only if its schema and protocol are compatible with the current database; never roll the database back to an old disk image. Use the deletion-aware snapshot and restore procedure in `pilot-operations.md`. Off-server recovery and operational qualification remain release gates; a persistent disk alone is not a backup.

### Observed installation checks

On the new Ubuntu server, all 11 `test/hosted-auth.js` tests and `test/protocol-smoke.js` passed. The production-only dependency install reported zero known vulnerabilities. Public DNS resolved to the new server and curl verified its HTTPS certificate. These checks do not prove real OAuth, live collaboration, signed distribution or customer-alpha readiness.

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
