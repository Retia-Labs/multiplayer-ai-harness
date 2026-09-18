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
