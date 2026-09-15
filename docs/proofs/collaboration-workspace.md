# Collaboration workspace — 2026-09-15

Implementation for #67 and #68, extending the shared web/desktop renderer on main `929325a`.

## Changes

- Private `/t/:id` links load root-relative application assets in the browser and the installed app. Authentication, device verification, project access and authenticated history remain required. The installed Content Security Policy is unchanged.
- Switching tasks clears the previous catch-up projection. Late project-access responses cannot overwrite the currently selected task. Temporary disconnects retain verified records and label current execution unknown.
- Focused forms cannot retain enabled controls after disconnect, authority changes or expiry. Reconnect refreshes the teammate selector. Sending requires a verified snapshot and confirmed execution host.
- Drafts retain their original turn. A changed turn produces an actionable error, preserves the text and dispatches no command. Receipts explain acceptance, delivery, rejection and unknown delivery separately. The heading shows the host-recorded agent-turn state.
- The exact approval grant and its removal control sit beside their request. Delegation and grant removal disable offline. Existing host authority, competing-decision settlement, encrypted transport and local provider execution remain unchanged.

No new dependency, provider backend, workflow or protocol is introduced.

## Design evidence

Contracts: `shell`, `review`, `evidence`, `decision`, `setup`. Reuses `uiButton`, `uiField`, `uiSection`, the existing catch-up renderer, project rail, task composer and mobile drawers. Compared with `docs/design/plexus/design/qa/alpha/approval-desktop.png` and `review-mobile.png`.

Intentional changes are additional receipt/freshness explanations, visible turn state and moving the scoped grant into the decision section. Fonts, tokens, layout and reference baselines are unchanged. Captures use 1487 × 1058 and 390 × 844 with reduced motion; mobile capture waits for the navigation drawer to leave the viewport.

Evidence is recorded under [collaboration-workspace](collaboration-workspace/). The approval mobile capture shows the exact action, host, scope, grant and decision buttons together. Desktop disconnect retains the selected recipient and verified discussion, disables controls, and labels queued delivery unknown. Mobile review retains the existing source-backed diff and discussion drawer without page overflow.

## Verification

The production browser test exercises two separate browser identities against the real encrypted hub and runtime, with a deterministic demo provider and real filesystem effects. Desktop installation uses the same renderer in an isolated unsigned macOS arm64 app. These checks do not substitute for a real second machine or real-provider release qualification.

- Encrypted workspace browser: 20 scenarios passed with zero renderer errors; private-link login/reopen, enrollment/history, human help/handoff, focused disconnect/reconnect, two attributed directions without duplicate messages, stale draft refusal, confirmed interruption, scoped delegation/revocation/expiry, mobile, recovery, failed replay isolation and provider failures.
- Host controls: 20 tests passed, including competing responses, stale/retried commands, removed devices, history transfer boundaries and receipt authentication.
- Unit: 25 passed. Protocol smoke and legacy multiplayer (38 checks) passed.
- Catch-up: 7 rendered checks and 4 enrollment/error precedence tests passed.
- Pilot: 11 boundary tests passed, 1 Windows-only test skipped; 7 browser scenarios and onboarding failure helper passed.
- Access: 12 revocation checks and 8 browser enrollment checks passed.
- Desktop source smoke passed. Fresh macOS arm64 installation: 6 installer checks and 13 lifecycle checks passed, including startup recovery and no Node on PATH. The native tray/dialog handlers are exercised; the OS clicks themselves are not automated.
- Packaged `app.js`, `index.html` and `styles.css` were byte-compared with the tested working tree; [source hashes](collaboration-workspace/source-sha256.json) identify the exact production renderer. The installer record truthfully records base commit `929325a` plus a dirty working tree; it was freshly built, not a reused historical installer.
- `git diff --check` passed. Reference pack/agent entry points were not changed, so `check:design` is not a changed-pack qualification.

Regression discovery included a failing focused-disconnect test and the previously broken private-link entry path. Installed testing caught an incompatible document-base approach; final root-relative URLs preserve the existing `base-uri 'none'` policy. The duplicate-message assertion compares exact teammate text, excluding the demo agent's quoted summary.

## Remaining release gates

#69 remains open: the founder will arrange a second person/computer later. No two-machine result is claimed. Hosted-service qualification (#70), Windows qualification (#19), signed installers (#20) and release privacy/control review (#25) remain separate gates. This is implementation and local verification, not a claim that early access is launch-qualified. GitHub Actions remains disabled.
