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
