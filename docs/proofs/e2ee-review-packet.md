# Review packet for issue #3's qualified review gate

## What this is, and what it is not

This is **not** the review [#3](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/3)
is waiting for. That criterion asks for a *named qualified reviewer* who records the reviewed
commit, findings and disposition, and neither half of that phrase is satisfied by anything in
this repository: an author reviewing their own work is not independent, and a name on a
disposition means somebody accountable for it being wrong.

This is the adversarial pass that makes the real review cheap. It records what was attacked,
what broke, what was fixed, and the specific claims a reviewer is being asked to accept or
reject. Findings here are AI-assisted review of code the same assistant wrote, which is the
weakest possible provenance for a security assessment - treat every disposition below as a
claim to check, not a result to inherit.

The existing [verification record](e2ee-verification.md) says the same thing about the PR #35
review, and that judgement was correct. This packet does not change #3's status.

## What a reviewer must cover, and what moved since the threat model was written

[The threat model](e2ee-threat-model.md) names the scope: SDK use and authenticated
attribution, key recipient selection, confirmation channels, recovery scope and freshness,
lost-host state and identity succession, every-sender rotation, offline and live freshness,
MLS tradeoffs, browser and OS key custody, package signing and update trust, and customer
boundary wording.

Three slices have landed against that scope since it was written, and two of them changed
security-relevant behaviour rather than merely adding features:

| Slice | What changed that a reviewer must assess |
| --- | --- |
| [#6](encrypted-task-replay.md) | The versioned encrypted task log, its digest chain, and a blanket refusal of every imported session |
| [#8](teammate-enrollment.md) | Project grants; endpoint enrolment and confirmation authority; **narrowing #6's refusal so some imported sessions are readable**; waiving device attribution for those sessions |
| [#9](catchup-projection.md) | An endpoint-side projection over decrypted events; `decision.recorded` added to the event vocabulary |

The second row is the one to start with. It is the only change that *relaxed* a rule.

## Findings from this pass

### F-1 · Forged history attributed to the execution host · was exploitable · fixed

**Attack.** An exported megolm session states its sender keys as claimed metadata chosen by
whoever exported it. #8's first contract accepted a history handoff sealed by any endpoint the
joiner had confirmed. So a confirmed teammate could create a session of their own for a task's
room, rewrite `sender_key` and `sender_claimed_keys` to the execution host's identity keys,
seal it as a project-history handoff, and have fabricated events read as the host's writing.
The relay is untrusted in this model, so serving the fabricated records is assumed.

**Status.** Reproduced end to end in `test/e2ee-import-forgery.js`, which succeeded against
the original contract. The handoff is now bound to the writer: only the execution host that
wrote the log may perform one, and `acceptProjectAccess` requires the writer identity and
checks it against the seal's actual sender. The same harness is retained as a regression test
and now fails with `project_history_not_from_writer`.

**For the reviewer.** Is binding to the writer sufficient, or does the imported-session
allowance need removing altogether? The residual exposure is a compromised execution host,
which can already write whatever it likes into the log - so the fix arguably adds no new
trust. Confirm that reasoning or reject it.

### F-2 · Device attribution is waived for admitted sessions · accepted risk · unresolved

An exported session carries no device id, so an admitted session cannot be matched against a
device name. The reader still requires the writer's curve25519/ed25519 pair to match and the
device to have been confirmed locally. **A reviewer should decide whether key-pair identity
without device attribution is acceptable for authenticated attribution**, given F-1 showed
those claimed keys are exporter-controlled in the general case.

### F-3 · Owner recovery authority · narrowed during review · check the residue

Confirmation authority originally allowed the team owner to mark any endpoint verified using
account credentials alone. It now applies only while the owner holds no verified endpoint.
The residual question: an owner who has genuinely lost every endpoint is indistinguishable
from an attacker who has taken the owner's session, and both can enrol a new endpoint. The
mitigation is that enrolment alone moves no keys. Confirm that is enough.

### F-4 · Freshness cannot detect a withheld suffix

Carried forward from #6 and unchanged: a fresh endpoint with no trusted checkpoint cannot
prove an adversarial relay has not withheld events. #9's projection reports `unknown` when the
host is disconnected, which narrows the window in which a stale view looks current, but does
not close it.

### F-5 · Key exchange still runs on the in-process spike

`KeyDirectory`/`ExperimentRelay` remain the key transport; the real hub carries enrolment
*records* only. Any assessment of key recipient selection is assessing the spike, not a
deployed transport.

## Claims to accept or reject

1. Only the writing host can supply readable history for a task it wrote. (F-1)
2. Key-pair identity without device attribution is adequate for an admitted session. (F-2)
3. A grant conveys ciphertext and never keys; the two gates are genuinely independent.
4. Enrolment authority cannot be obtained from account credentials alone, except for a team
   owner with no endpoints, where it conveys no keys. (F-3)
5. `decision.recorded` does not let a relay or a peer manufacture an attributed decision.
6. The catch-up projection introduces no server-side plaintext projection.

## Reproduce

`npm ci`, then `node node_modules/electron/install.js`, then a browser via
`node node_modules/playwright-core/cli.js install chromium`.

- `npm run test:import-forgery` - F-1, must refuse
- `npm run test:teammate-enrollment` - enrolment, grants, revocation, site-data loss
- `npm run test:encrypted-task` - #6's log, replay and adversarial records
- `npm run test:catchup && npm run test:catchup:view` - #9's projection and screen
- `npm run test:e2ee` - #3's own acceptance matrix

## Disposition

**Open.** No named qualified reviewer has assessed this stack. This packet lists what to
attack and what has already broken; it does not substitute for that assessment, and #3 must
not be closed on it.
