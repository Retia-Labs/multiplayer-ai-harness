# Invited Mac alpha installation

Version: **0.2.0-alpha.1**, Apple Silicon (M1 or later). This invited-alpha build is **unnotarized** and has no Apple-verified developer identity. Intel Mac and Windows installers are not part of this artifact. Download availability and qualification are tracked in issue #76; a version number alone does not mean a release is available.

## Install

1. Download the versioned DMG from the Plexus release link supplied with your invitation. The release includes its SHA-256 checksum and source revision.
2. Open the DMG and drag Plexus into Applications. Eject the disk image, then open Plexus from Applications.
3. If macOS blocks the app because its developer cannot be verified, confirm that you obtained this exact Plexus alpha from the supplied release. In System Settings → Privacy & Security, use **Open Anyway** for Plexus if offered, then confirm the system prompt. Managed Macs may prohibit this; contact your administrator rather than changing system-wide protections. See [Apple's instructions](https://support.apple.com/en-gb/102445).
4. Select GitHub sign-in. In the browser, approve the desktop code shown by this installation. Your GitHub account must have invited-alpha access.
5. Create a private team or accept the single-use invitation addressed to your verified GitHub email. Ask the team owner to verify your device when required.
6. In the desktop app, open Setup, pair this execution host, explicitly choose the project folder to share, and configure the supported Codex account. Account sign-in does not itself grant project access or execution authority.

A browser teammate signs in at https://app.tryplexus.dev, accepts their invitation and completes device verification. The execution host must remain connected for agent work. Provider credentials stay on the execution host.

## Update

Quit Plexus before replacing the application with a newer invited-alpha build. Keep the existing application data; replacing the app must not require deleting your account session or encrypted endpoint identity. Upgrade qualification must be recorded for each distributed artifact. Do not use an older database snapshot to recover access.

## Release boundary

The founder approved unnotarized distribution only for the first invited Mac alpha on 2026-09-19. This does not establish Apple notarization, Windows support, successful two-machine collaboration, or completion of the other release checks. Installation and upgrade evidence must identify the exact distributed checksum.
