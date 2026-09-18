# Hosted alpha setup

Status: configuration prepared; not deployed or qualified. Issues #75, #76 and #70 remain open until their full acceptance checks pass.

## Service

Use the root `render.yaml`: one Node web service in Singapore, 0.5 CPU/512 MB, one 1 GB disk mounted at `/var/data`. Build with `npm ci --omit=dev`; start `node packages/hub/server.js`. Do not run Electron on Render. The relay honors `PORT`, binds `HUB_HOST`, and stores SQLite at `/var/data/plexus.sqlite`. Health check: `/api/health`. Deploys are manual; GitHub Actions remains disabled.

On 2026-09-18, the Render creation screen quoted US$7/month compute and US$0.25/GB/month disk: US$7.25/month base for this configuration, before tax, bandwidth or other usage. No purchase was made. A persistent disk disables zero-downtime deploys and horizontal scaling. Reassess capacity from measured invited-alpha usage.

## Identity and domain

1. Register an organization-owned GitHub OAuth app named **Plexus Alpha**. Homepage: `https://app.tryplexus.dev`. Exact redirect: `https://app.tryplexus.dev/api/auth/callback`. No wildcard redirects or GitHub device flow needed. Keep expiring GitHub tokens enabled; Plexus does not store provider tokens or refresh tokens.
2. Put its client ID and secret directly into Render's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` secret fields. Never commit them, paste them in an issue, or put them in the desktop build. Credential creation/entry is an account-owner step.
3. Set `PLEXUS_ALPHA_GITHUB_IDS` to comma-separated immutable numeric GitHub user IDs. This admits accounts to the alpha, not to a team or project. Remove an ID and restart to end that account's hosted access; persisted sessions are checked against the active allowlist.
4. Add `app.tryplexus.dev` in Render's custom-domain settings. Use the exact DNS target provided there at the authoritative DNS provider. Verify the certificate and HTTPS/WSS before sign-in. Do not point the domain at an unconfigured name-login service.
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
