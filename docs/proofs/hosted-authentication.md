# Hosted authentication implementation evidence — 2026-09-18

This records local implementation checks and the separately identified production qualification below. It is not an alpha-readiness claim.

## Behavior

- GitHub authorization code + S256 PKCE; browser-bound single-use state; exact local return paths.
- Stable provider ID, verified email, invited-account allowlist; no merging with legacy name accounts.
- Hashed persistent seven-day sessions; Secure/HttpOnly cookie; CSRF origin checks; logout/expiry terminate live sockets; URL tokens and legacy account tokens rejected in hosted mode.
- Desktop system-browser exchange with explicit code consent, installation verifier, expiry and single use. Main-process OS sealing and per-service profile boundary.
- Owner-only invitations addressed to a verified email and bound to the recipient account.
- A host credential does not grant human account/team authority.

## Checks

| Check | Result |
| --- | --- |
| `npm run test:hosted-auth` | 11 passing boundary tests, including persistence/revocation across restart |
| `npm run test:hosted-auth:browser` with isolated Chrome | Passed HTTPS sign-in/private-link/team/encrypted-endpoint path; desktop consent/exchange/store/logout; browser logout; service failure/retry and expired callback |
| `PLEXUS_TEST_NATIVE=1 npm run test:hosted-auth:browser` | Passed actual Electron IPC, HTTPS relay, WebSocket sign-in, OS safeStorage, persisted account on restart and logout |
| `npm run test:protocol` | Passed |
| `npm run test:unit` | 25 passed |
| `npm run test:e2e` with isolated Chrome | 38 multiplayer checks passed |
| `node test/encrypted-workspace-browser.js` with isolated Chrome | 20 encrypted workspace checks passed |
| `node --test test/desktop-profile-isolation.js test/durable-host.js` | 3 passed, including actual Electron profile isolation |

External seams: GitHub token/user/email responses are fixtures. HTTPS uses a temporary test certificate. The base desktop exchange test injects an OS sealer; the additional native run uses actual Electron safeStorage on this Mac. System-browser navigation is routed into the isolated fixture browser. Live GitHub OAuth remains unqualified. The installed app was not rebuilt or signed by these checks. The existing workspace test uses a deterministic provider; no new real-provider run is claimed.

## Design

Templates: `shell` + `setup`, extended at account entry before the workspace shell exists. Reuses the production brand assets, Outfit, login card, input, primary/secondary button and status styles. Intentional departure from the accepted setup screen: signed-out users see a focused account card without task navigation; account login precedes host/project/provider setup. Existing workspace composition remains.

Screenshots were inspected against `docs/design/plexus/design/qa/setup-desktop.png` and the shared design rules at 1487×1058 and 390×844. No reference baselines changed. Generated evidence under `.artifacts/hosted-auth/`:

- `sign-in-desktop.png`, `sign-in-mobile.png`
- `desktop-consent.png`
- `native-desktop-waiting.png`, `native-desktop-signed-in.png` (actual Electron window)
- `sign-in-unavailable-mobile.png`, `sign-in-expired-mobile.png`

No horizontal clipping was observed. The test checks mobile page overflow. Native screenshots confirm the installed-renderer sign-in and connected states; the production GitHub screens and signed distribution are not covered.

## Remaining release evidence

Real GitHub credentials, live HTTPS/WSS/domain qualification, signed packaged-app sign-in, signed installers/upgrades, separate physical machines, Windows and independent privacy/control review. Keep #75/#76/#70 open; this proof does not close them.

### Review captures

- [Desktop browser sign-in](hosted-authentication/sign-in-desktop.png)
- [Native desktop waiting for authorization](hosted-authentication/native-desktop-waiting.png)
- [Native desktop signed in](hosted-authentication/native-desktop-signed-in.png)

Desktop follow-up: the native test also verifies that an unconfigured execution host leaves provider selection and Send disabled. The renderer no longer invents a configured demo provider when no host advertises one. Native captures use the 1487×1058 CSS viewport.

## Production installed-app qualification — 2026-09-19

An internal ARM64 DMG built from application revision `ec4d031` was mounted read-only and copied into an isolated test directory. The installed executable used the packaged default `https://app.tryplexus.dev` without a service URL override. The account owner approved its desktop exchange in Chrome.

Verified against the live service:

- The installed app consumed its approved exchange and connected over authenticated WSS.
- No account session was stored in renderer localStorage.
- Restart restored the same account. Electron reported OS encryption available and the persisted credential did not contain the plaintext session token.
- Sign-out removed the local credential; the old bearer session returned HTTP 401 from `/api/auth/session`.
- A second restart remained signed out.

Artifact: `Plexus-0.1.2-mac-arm64.dmg`, SHA-256 `7f91bdacb15c6630d23e8464b4ce833794829cdeb0814a2e37fb019f013776e1`. This is an internal unnotarized build, not a published release. Generated evidence and the probe scripts are under `.artifacts/hosted-installed/` (ignored). The initial restart probe needed a guarded wait for renderer initialization; the corrected probe passed.

Limitations: the test captured the browser destination and opened it in Chrome, so it did not qualify the OS default-browser opener. A locally built DMG does not establish downloaded-app Gatekeeper behavior. No project sharing, execution-host approval, real-provider task, second physical machine or trusted installer qualification is claimed.

## Hosted onboarding corrections — 2026-09-19

Settings uses the verified GitHub email for hosted invitations, with an accessible field label and matching copy feedback. Local mode retains its account-ID field. Setup directs invitations through Team & access. Provider readiness stays pending until an execution host is online, including when a cached provider was previously ready; a connected host can still report a real provider failure. Settings directs provider setup to the desktop app rather than environment-variable edits.

Design: `shell` + `setup`; reused Settings modal fields/buttons and the existing setup checklist. Compared the rendered screens with `design/qa/setup-desktop.png` and the accepted shared typography/surface rules. No layout, token or baseline changes. The existing project-centered production shell remains an intentional extension of the reference.

Validation: `node --test test/pilot-operations.js` passed 12 tests, with one Windows-only skip. `test:hosted-auth:browser` passed the HTTPS fixture journey including verified-email Settings, missing-host pending status, desktop exchange and logout. Screenshots under `.artifacts/hosted-auth/`: `settings-hosted-desktop.png`, `settings-hosted-mobile.png`, `setup-hosted-desktop.png`, `setup-hosted-mobile.png`, at 1487×1058 and 390×844. Changed controls/checklist were visually inspected without clipping. These latest UI changes have not yet been deployed or rebuilt into the installed DMG.

## Invitation lifecycle — 2026-09-19

The owner-only `team/invite/list` operation returns persisted invitation history scoped to the requested team. The shared Setup team controls display pending, accepted, expired and revoked states, with refresh and pending-only revoke actions. Status is explicitly labelled as last refreshed. Refresh clears a newly issued code when it is no longer pending. Revoking a terminal invitation preserves its receipt; revoking an accepted invitation never removes membership.

Validation: hosted authentication 12 tests passed (expanded owner/non-owner, cross-team, recipient, revoked, expired and terminal-receipt assertions); 68 team boundary checks passed; protocol smoke passed. The hosted browser journey passed real UI revocation and receipt persistence through a page reload. Account and terminal-status setup use local fixtures; this is not a real second-person production invitation proof.

Design: `shell` + `setup`, existing team rows, fields and buttons; no new tokens or baseline changes. Inspected `.artifacts/hosted-auth/invitations-desktop.png` at 1487×1058 and `invitations-mobile.png`, a focused panel capture at a 390×844 viewport. The existing flat, compact team controls remain; no clipping was observed in the changed panel. Latest changes remain pending deployment and packaged-app rebuilding.
