# Linking a task to the issue it belongs to (issue #14)

Implementation for [issue #14](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/14)
(P13), built on [#8](teammate-enrollment.md)'s enrolment and [#12](help-inbox.md)'s sealed
control channel.

## A tracker URL is content

It names a repository, an issue number and usually the shape of the problem. So it goes into
the encrypted log with everything else rather than into a relay column somebody could read — a
canary scan asserts the relay holds neither the URL nor even which tracker it is.

That means the same shape as every other teammate-written record: sealed to the host, appended
by the host, attributed to the endpoint that actually sealed it.

## What a link is allowed to be

`packages/protocol/related-work.mjs` is the rule, shared because it has to be agreed in two
places that do not trust each other. A client checks so the person typing gets an answer
without a round trip; **the host checks because the log is the copy everybody renders**. A
client that skipped the check gets the same refusal — asserted by sending `javascript:` past a
client that would have stopped it.

| Refused | Code |
| --- | --- |
| `javascript:alert(1)` | `unsupported_link_scheme` |
| `data:text/html,…` | `unsupported_link_scheme` |
| `file:///etc/passwd` | `unsupported_link_scheme` |
| `https://github.com@evil.example/issues/7` | `credentials_in_link` |
| anything that is not a URL | `invalid_link_url` |

The scheme list is `https:` and `http:` and nothing else. Everything else that can appear in an
`href` is a way of running something in a reader's browser or smuggling content past a
boundary. There is no allowlist of hosts, because which tracker a team uses is their business.

Credentials are refused separately because they are a phishing shape rather than a scheme
problem: `https://github.com@evil.example` reads as GitHub and navigates somewhere else.

What gets stored is the **parsed** href, not the caller's string, so what is recorded is what a
browser would actually resolve.

## Rendered so a reader can judge it

The screen shows the link's **host** next to its label, and an `http:` link is marked as not
encrypted in transit. Titles have control characters stripped rather than being rejected, so a
title cannot fake a second line. Every anchor is built with `textContent`,
`rel="noopener noreferrer nofollow"` and `target="_blank"` — nothing on this path goes near
`innerHTML`.

## The private link

`/t/<taskId>` — an identifier and nothing else. No key, no token, no title.

The relay serves **the same application shell it serves everybody**, and the test asserts
three things about it: it contains no task content, it does not contain the task id it was
asked about, and **a link to a task that does not exist answers identically**. Byte-for-byte
identical, so the link cannot be used to find out whether an id is real. That is the one thing
an unauthorized visitor could otherwise learn from it.

Everything that decides whether its holder may read anything happens afterwards, in the client:

1. **Authentication** — no session, no task list; the app shows its login.
2. **Membership** — the relay refuses `/api/encrypted-tasks?team=…` to an account outside the
   team, asserted with a second account (`not_a_member`).
3. **Endpoint verification** — the catch-up screen refuses to decrypt anything until this
   device has been confirmed by somebody, which is #8's ceremony and #9's screen.

A link naming a task this account cannot open says exactly that, and says it the same way
whether the task does not exist, belongs to another team, or has simply not been shared.

## The criteria

**1 · validate schemes, render safely, store encrypted, round-trip across authorized clients**
— met, and the validation is asserted from both sides of the trust boundary.

**2 · a private link routes to authentication, membership and endpoint verification; never
reveals content to an unauthorized visitor** — met, including the identical-answer property
for a task id that does not exist.

**3 · adding an association does not read, comment on, or publish to the external tracker** —
met. Nothing on this path makes a request anywhere: the URL goes into the log and nowhere else,
and the test asserts the host made no request to the tracker host.

**4 · add and remove associations, navigate from the same link after reconnect; no tracker
integration required** — met. Removing a link takes it out of the projection while the log
keeps the fact that somebody added and removed it, with both events sourced. No tracker API is
called, configured or required.

## Reproduce

`npm run test:related-work` — 18 checks: the validator on its own with no network anywhere
near it, the round trip through the encrypted log, the host refusing what a client would have,
the projection's host and source, removal and the refusal of a removal nobody asked for, the
relay canary scan, the private link's three properties, and the membership refusal.

## Limits

There is no tracker integration and none is planned here: nothing reads issue state, syncs a
title, or posts back. A stored link is a link.

A link's title is whatever the person adding it typed. Fetching the real issue title would mean
the host making a request to the tracker, which criterion 3 rules out.
