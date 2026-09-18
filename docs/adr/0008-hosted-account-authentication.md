# ADR 0008: Hosted accounts and installation sign-in

Status: implemented; production browser OAuth and restart persistence verified on DigitalOcean. Production authorization, protected storage, restart and logout also passed in an internal installed Mac build. Signed distribution and full release qualification remain pending (#75).

## Decision

Keep the monorepo and deploy the relay/browser independently from the desktop execution host. The hosted service uses GitHub OAuth authorization code flow with S256 PKCE and a browser-bound, single-use state cookie. Stable GitHub numeric IDs identify accounts; names and email addresses never merge identities. Invited alpha access requires an explicit numeric-ID allowlist.

Browser sessions use a Secure, HttpOnly, SameSite=Lax host-only cookie. The relay persists only SHA-256 session hashes, expires sessions after seven days, rejects old local account tokens, and closes live clients on logout or expiry. Unsafe cookie-authenticated requests require the configured Origin. Hosted mode rejects URL account tokens and name-only WebSocket login. Production/Render/exposed CLI configuration fails closed without hosted authentication.

The installed desktop starts an installation-bound exchange and opens the configured service in the system browser. A signed-in user enters the code shown on their desktop. Only the initiating installation's verifier can consume the approval, once, within ten minutes. The main process saves its account token through Electron safeStorage and refuses an unavailable or plaintext OS backend. The renderer receives the token in memory for its WebSocket; hosted credentials are not saved to localStorage. Each service retains its own existing desktop profile. Packaged builds default to `https://app.tryplexus.dev`; development keeps its loopback service.

Team owners can address invitations to an existing account's verified GitHub email. Ambiguous/missing matches fail. The invitation remains single-use and bound to the resolved account ID, and acceptance does not verify a device or grant project history. This alpha does not send invitation email; the owner shares the generated code. Recipients must first sign in with an allowlisted GitHub account.

## Boundaries retained

Account authentication is independent of browser endpoint keys, device verification, project membership/history, local folder consent, provider login, execution-host pairing, scoped action approval and owner recovery. A hosted runtime proves its installation credential; it cannot use the runtime role to perform human account operations. GitHub credentials remain transient in the service's identity exchange and are never used to execute agents.

## Operational limits

One relay instance with persistent SQLite. Pending login/exchange state is in memory: restarting cancels in-progress sign-ins, while issued sessions survive. Single-instance deployments interrupt connections on restart; existing reconnect/replay behavior remains necessary. Application-aware deletion/revocation-preserving recovery is required; restoring an old whole-disk snapshot is not a safe account or content recovery procedure.

Local tests stub GitHub's external identity response. The base desktop exchange test substitutes the OS sealing primitive; the native fixture also exercises real Electron safeStorage, restart and logout on the development Mac. These do not prove production OAuth configuration, signed distribution, two physical machines, or external privacy/control review. Those release gates remain open.

References: [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Render blueprint](https://render.com/docs/blueprint-spec), [operations](../operations/hosted-alpha.md).
