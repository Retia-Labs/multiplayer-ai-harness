# Changelog

User-visible changes by version. Dates identify publication only when an entry explicitly says **published**. Draft candidates and development baselines are not released products.

## Unreleased

Changes after the `0.2.0-alpha.1` candidate build:

- Added authenticated installer delivery and a browser setup download card with version, architecture, unnotarized notice, checksum and retry states. The service validates configured installer bytes before advertising them.

- Added this changelog and linked it from the README.
- Verified replacement of the internal 0.1.2 app with the 0.2.0-alpha.1 DMG preserves the hosted account session and encrypted device fingerprint; logout clears the saved credential afterward (isolated HTTPS fixture).
- Extended the native authentication test to run against an installed application. Verified the candidate DMG's authentication and startup-recovery paths using isolated fixtures.

## 0.2.0-alpha.1 — draft candidate (2026-09-19)

**Status:** uploaded as a draft prerelease; not published to testers. Apple Silicon Mac only. The DMG is unnotarized and has no Apple-verified developer identity. The founder approved this distribution exception for the first invited Mac alpha.

### Added

- Invited-account GitHub sign-in for the hosted app, using verified identity and email.
- Desktop authorization through a browser with an installation-specific confirmation code; macOS-protected session storage, restart persistence and sign-out.
- Hosted relay and browser app at `app.tryplexus.dev`, with HTTPS/WSS and daily local ciphertext snapshots.
- Owner-only invitation history showing pending, accepted, expired and revoked states, plus revocation of pending invitations.

### Fixed

- Oversized or malformed WebSocket messages no longer crash the relay.
- Hosted Settings identifies the verified invitation email instead of asking users to share an account ID.
- Provider readiness stays pending while the execution host is unavailable.
- Revoking an accepted invitation preserves its acceptance record and does not remove the member.

### Changed

- Packaged desktop builds connect to the hosted Plexus service by default.
- Hosted mode rejects name-only login and legacy account tokens. Existing local identities are not automatically merged into GitHub accounts.
- Setup directs users to the desktop app for Codex configuration. Provider credentials, project sharing and execution authority remain host-local and separate from Plexus sign-in.

### Distribution and known limits

- Application source: [`bbe643c`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/bbe643c989df32b69463aa8de5848743d203ee7e).
- Artifact: `Plexus-0.2.0-alpha.1-mac-arm64-unnotarized.dmg`.
- SHA-256: `e5317610d3049b8653ae5329eaf43030240d6d1b9a919d32e8b4f0575e5c9a9e`.
- [Installation instructions](docs/operations/invited-mac-alpha.md) and [qualification evidence](docs/operations/hosted-alpha.md).
- Downloaded-app Gatekeeper handling, provider/task continuity during upgrades, two-physical-machine production collaboration and remaining release gates are incomplete. No Intel Mac or Windows artifact is included.

[Changes from the pre-hosted baseline](https://github.com/Retia-Labs/multiplayer-ai-harness/compare/6ab3d641f7a61d15edb4fff7f8cc42ec78a3c29e...bbe643c989df32b69463aa8de5848743d203ee7e).

## 0.1.2 — development baseline

The repository used this package version for multiple development iterations. No published release or single immutable artifact is established for it; this entry summarizes the pre-hosted baseline at [`6ab3d64`](https://github.com/Retia-Labs/multiplayer-ai-harness/commit/6ab3d641f7a61d15edb4fff7f8cc42ec78a3c29e).

- Project-centered workspace, shared task discussion, review, steering and scoped approvals.
- Encrypted collaboration, explicit device/project access and customer-held recovery.
- Local execution hosts, supported Codex integration and desktop lifecycle controls.
- Pilot setup, diagnostics, deletion, optional measurement and operator seat tools.

Earlier version histories have not been reconstructed; this log does not assign unverified release dates or publication claims.

## Maintaining this log

Add user-visible changes under **Unreleased** as work lands. When preparing a version, move its changes into a dated candidate entry and identify the exact source revision and artifacts. Mark it published only after publication succeeds. Record breaking changes, migration steps, platform limits and known issues. Never replace an existing version's artifact silently; use a new version and checksum. Keep detailed test logs in the linked proof documents.
