# Issue #3 verification record

This record separates executable evidence from the qualified review gate.

| Check | Result |
| --- | --- |
| Windows source browser/desktop/runtime experiment | 10 checks passed, including scoped recovery and corrupt storage |
| Windows packaged desktop experiment | All 10 complete checks passed in CI, including disconnect races, stale receipts and membership rollback |
| macOS packaged desktop experiment | All 10 complete checks passed in CI with OS-protected persistent storage |
| Legacy encryption primitive matrix / spike | 22 passed, 6 informational records, 0 blocked, 0 failed / 9 passed |
| Regression suites | `npm test` passed: protocol, 16 unit, 68 team-boundary, 9 control-plane checks and multiplayer browser E2E |
| Design integrity | `npm run check:design` and GitHub design checks passed; no production UI or reference baseline changes |
| Dependency scan | `npm audit --audit-level=low`: 0 vulnerabilities |
| Independent qualified protocol/threat-model review | Pending reviewer, reviewed commit, findings and disposition |

Both packaged platforms passed against code commit
`b3873b89411fd5df8a97df86281021fae8a6a3ad` in
[GitHub Actions run 34039737143](https://github.com/Retia-Labs/multiplayer-ai-harness/actions/runs/34039737143).
Both used Electron 44.2.0, its bundled Node 24.20.0 and Matrix crypto WASM SDK 18.8.0.
The [retained platform results](e2ee-platform-results.json) preserve the exact reports
beyond CI artifact expiration. Future local reports go to `.artifacts/e2ee-complete/`.
Reports contain no recovery secret or test plaintext.

This is isolated from the production hub. Browser coverage is Chromium, not Safari or
Firefox. Packaged checks use unsigned unpacked apps; installer distribution, notarization
and update signing remain release gates.

## PR #35 author-assisted review (Codex, 2026-09-06)

Reviewed `d78d16d2b5b491eea3fb48a655f21d11436da23c` and the follow-up changes for
endpoint trust, project key recipients, authenticated sender binding, durable grant
consumption, membership/receipt races, recovery scope, desktop IPC/storage, relay
isolation and consistency between the evidence and threat model. This is an AI-assisted
code review of the author's work, not independent qualified cryptographic review.

Findings addressed before merge:

- The test launched Electron with `--no-sandbox`, so the original packaged reports
  did not establish the claimed sandbox configuration. Removed that override; the test
  now checks sandbox enabled, context isolation enabled, Node integration disabled and
  absence of the override. Electron documents the flag's effect in its
  [sandbox guide](https://www.electronjs.org/docs/latest/tutorial/sandbox).
- The tamper probe changed the export's format/version byte. It now changes encrypted
  payload bytes while preserving the header/version, exercising integrity rejection.
- Recovery scope needed an explicit temporal boundary. Added a test and documentation
  showing that recovered keys read later messages in the same session while still
  excluding rotated sessions and other projects.

The historical platform JSON above is retained unchanged. The follow-up revision must
pass packaged Windows/macOS CI before merge; its exact commit and CI disposition are
recorded in the PR review. No production crypto integration or UI change is introduced.
Independent qualified review remains tracked by issue #3 rather than being represented
as completed by this author-assisted review.
