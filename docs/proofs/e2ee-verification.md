# Issue #3 verification record

This record separates executable evidence from the qualified review gate.

| Check | Result |
| --- | --- |
| Windows source browser/desktop/runtime experiment | 10 checks passed, including scoped recovery and corrupt storage |
| Windows packaged desktop experiment | Initial 9 checks passed; expanded final run pending |
| macOS packaged desktop experiment | CI pending |
| Regression suites and dependency scan | Final run pending |
| Independent qualified protocol/threat-model review | Pending reviewer, reviewed commit, findings and disposition |

Current reports are generated under `.artifacts/e2ee-complete/` and uploaded by CI.
Final run URLs and platform versions will be recorded here. Reports contain no recovery
secret or test plaintext.

This is isolated from the production hub. Browser coverage is Chromium, not Safari or
Firefox. Packaged checks use unsigned unpacked apps; installer distribution, notarization
and update signing remain release gates.
