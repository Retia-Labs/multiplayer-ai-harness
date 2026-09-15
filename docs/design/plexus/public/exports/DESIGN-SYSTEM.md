# Plexus app design system

This guide turns the selected **Review together** direction into reusable app screens. The target is a shared workspace where teammates can inspect agent work, understand its sources, and decide what happens next. The visual reference is [selected-direction.png](design/selected-direction.png); the product requirements come from the repository's [current specification](../../planning/product-spec.md), published as [issue #1](https://github.com/Retia-Labs/multiplayer-ai-harness/issues/1).

This is a frontend concept. UI examples do not implement authentication, provider execution, encryption, access enforcement, or durable event delivery. The template contracts describe the meaning a connected implementation must preserve.

## Visual foundation

Keep the Plexus website's local Outfit typeface, restrained pale-green accent, dark surfaces, and supplied logo artwork. Adapt the website's large spacing to dense shared work. Use flat sections with fine dividers; reserve framed panels for a diff, an input, a source, or a decision that belongs together. The bundled [tokens](design/plexus-app.tokens.json), [Plexus artwork](public/assets/plexus-symbol.svg), and [Outfit font](public/assets/outfit.woff2) are the identity references available in this repository. The existing [shared renderer stylesheet](../../../apps/web/styles.css) contains the production palette to reconcile during implementation.

| Token | Value | Application |
| --- | --- | --- |
| Background | `#080A09` | App canvas and code reader |
| Surface | `#101310` | Quiet grouped content |
| Raised | `#161A16` | Selected or nested content |
| Ink | `#EEF1E9` | Primary text |
| Muted | `#969D94` | Supporting text; verify against its actual background |
| Accent | `#D5F5A3` | Primary action, selection, positive state |
| Accent ink | `#182010` | Shared primary-button text on pale green |
| Divider | `rgba(225,239,217,.12)` | Decorative separation, not the only control boundary |
| Warning / danger | `#DFBA60` / `#E29E98` | Pending or rejected states, always with text |
| Control radius | `5–6px` | 5px buttons; 6px shared fields and composer |
| Panel radius | `5–12px` | 5px review panels, 8px template cards, 12px dialogs |
| Spacing | `4, 8, 12, 16, 20, 24, 32, 40, 48, 64px` | Use multiples of the 4px base |

[plexus-app.tokens.json](design/plexus-app.tokens.json) contains portable values and reference measurements. It is a project token format, not a DTCG document or JSON Schema. Values describe the design contract; CSS remains the source of truth for the rendered prototype.

### Typography and iconography

| Role | Starting size / weight | Guidance |
| --- | --- | --- |
| Review page title | `30px / 450` | One or two lines; `1.2` leading, `-.04em` tracking; 27px at smaller widths |
| Review section title | `20px / 450` | Quiet hierarchy; smaller subheadings can use 17–19px |
| Body | `14–16px / 400` | Base 15px with `1.5` leading; discussion uses more leading |
| Supporting metadata | `10–13px / 400` | Base label 12px; reserve the smallest sizes for short secondary metadata |
| Read-only diff | `14px` monospace on desktop | Responsive 11–14px overrides; preserve spacing and local horizontal scrolling |

Management screens use larger `29–40px` headings and the template gallery uses `26–38px` headings. Miniature specimens inside the gallery may use smaller type; do not copy specimen text sizes into a full screen.

The isolated preview loads Outfit from `/assets/outfit.woff2` and uses `@phosphor-icons/react` for real icons. In production, reuse the shared renderer's font and icon loading approach while preserving the same appearance; this reference does not require a React migration. Use the supplied SVG for the Plexus mark. Keep icon size and weight consistent within a row. Pair unfamiliar or stateful icons with labels. Shared person avatars are circular; the shared agent avatar has a 9px radius. Use initials for sample people and an agent mark for Codex; do not substitute an agent for its human sender.

## Shared workspace layout

The selected 1487 × 1058 reference has an approximately 86px top bar, 304px task rail, 759px work area, and 424px discussion inspector. Use the proportions without scaling text down to fit a screenshot.

```text
┌───────────────────────────────────────────────────────────────────┐
│ Plexus       Workspace / Task                 Host status   People │
├───────────────┬──────────────────────────────┬────────────────────┤
│ Tasks         │ Page title                   │ Review together    │
│               │ Attributed direction         │ Summary + sources  │
│ Changed files │                              │                    │
│               │ Shared read-only artifact    │ Human / agent      │
│               │                              │ discussion         │
│ Responsible   │ Latest check + source        │                    │
│ Host/account  │ Related work                 │ Targeted composer  │
│ Handoff       │                              │                    │
└───────────────┴──────────────────────────────┴────────────────────┘
```

| Region | Desktop rule | Narrow-screen rule |
| --- | --- | --- |
| Top bar | `86px`; concise breadcrumb and presence | `68px` at `760px` and below; simplify labels while retaining the current task |
| Task rail | `clamp(240px,20.4vw,304px)` | 235px at `1101–1200px`, 230px at `761–1100px`; a 280px left drawer with backdrop at `760px` and below |
| Work area | `minmax(0,1fr)` | Retain readable text and locally scrollable code |
| Inspector | `clamp(340px,28.5vw,424px)`; 335px at `1101–1200px` | At `1100px` and below, open as a fixed right drawer up to 420px wide; full viewport width at `760px` and below |
| Review padding | `32px 30px 30px`; `17px` panel gaps | At `760px` and below, use `26px 20px 35px`; code keeps its own overflow region |

The app uses a viewport-height shell with independently scrolling work and side regions. It supports a minimum CSS viewport width of 360px. Opening a drawer does not move discussion or navigation into the work area's reading flow. Keep the drawer controls available when extending a screen.

Navigation, shared work, and discussion are the three primary regions. Do not nest them inside a second card shell. Keep selected tasks legible with both a surface change and an accent edge. Host and provider context belong near responsibility so the user can understand where work executes before requesting a handoff.

## Reusable screen contracts

[screen-templates.json](design/screen-templates.json) records each template's named slots, required content, states, and semantic rules. Required slots may share a visual region; they must not disappear when a screen is simplified. The states are a design inventory, not a claim that the prototype exercises every state.

| Template ID | Required slots | Use it for |
| --- | --- | --- |
| `shell` | `navigation`, `taskRail`, `ownership`, `main`; optional `inspector` | A stable workspace around every screen |
| `review` | `heading`, `attributedDirection`, `artifact`, `verification`, `discussion`, `composer` | Read-only diff review and targeted corrections |
| `evidence` | `scope`, `summary`, `records`, `detail`; optional `followup` | Activity, catch-up, test results, source inspection |
| `decision` | `request`, `scope`, `evidence`, `actions`, `receipt` | A per-action approval or responsibility handoff |
| `inbox` | `filters`, `items`, `detail`, `response` | Human help and approvals needing attention |
| `setup` | `workspace`, `host`, `provider`, `members`, `capabilityNotice` | Connection setup and project access |

### Semantics that must survive every layout

- **Ownership:** Name the responsible person, execution host, provider account, and event actor separately. A handoff changes responsibility while execution stays on the existing host.
- **Execution:** Host connectivity, agent turn state, and task outcome are independent. A lost connection can leave the outcome unknown. An interruption remains requested until the host acknowledges it.
- **Agent input:** Identify the sender, target agent, and target turn. Preserve a queued, delivered, or failed receipt. Reject a command for a stale turn instead of redirecting it silently.
- **Human help:** Give requests a recipient and open/resolved state. A human reply is not an agent instruction, and resolving help is not an approval.
- **Approvals:** Show the exact action, scope, requesting actor, host, and decision maker. Approval covers that action only. The first valid decision wins; later decisions must show the settled result.
- **Evidence:** Link summaries to source events, files, or recorded check results. Distinguish an agent's claim from a verification outcome. Display missing or stale evidence explicitly.
- **Access:** Explain that project membership includes existing history and future tasks. A revocation can remain pending on an unreachable host. Avoid promising that historical material already received has been erased.
- **Concept boundaries:** Label simulated setup, invitations, access changes, and encryption states. Do not imply that this frontend implements those protections or sends commands to a host.

## Shared UI primitives

The prototype exports the following React components from `src/ui.jsx`. They are visual primitives; the calling screen owns application state and event behavior.

Management screens currently have private `m-*` helpers in `src/management-screens.jsx`; those helpers are not exports from `ui.jsx`. Use the public primitives for new shared patterns.

| Export | Use |
| --- | --- |
| `Avatar` | Identify a person or agent near its own content |
| `Status` | Display a labelled state indicator |
| `Button` | Present a consistent action with a real handler and accessible label |
| `SourceLink` | Open the source supporting a claim |
| `Modal` | Inspect a source or complete a scoped action |

The source is JavaScript; the types below describe the current React props rather than exported TypeScript interfaces.

| Prop | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `Avatar.name` | `string` | No | `"Maya"` | Accessible actor label and initial |
| `Avatar.size` | `string` | No | `"normal"` | Suffix for the avatar size class |
| `Avatar.agent` | `boolean` | No | `false` | Render the Plexus symbol instead of an initial |
| `Status.children` | `ReactNode` | Yes | — | Human-readable state |
| `Status.tone` | `string` | No | `"neutral"` | State style; `success` and `warning` also select the corresponding icon |
| `Status.icon` | `boolean` | No | `false` | Show a state icon instead of a dot |
| `Button.children` | `ReactNode` | Yes | — | Action label |
| `Button.variant` | `string` | No | `"secondary"` | Suffix for the button variant class |
| `Button.className` | `string` | No | `""` | Additional classes |
| `Button.…props` | Native button props | No | — | Forwarded handler, disabled state, type, ARIA attributes, and other button properties |
| `SourceLink.children` | `ReactNode` | No | `"View source"` | Source-action label |
| `SourceLink.onClick` | `MouseEventHandler` | Yes | — | Open the relevant source |
| `Modal.title` | `ReactNode` | Yes | — | Visible and accessible dialog title |
| `Modal.children` | `ReactNode` | Yes | — | Dialog content |
| `Modal.onClose` | `() => void` | Yes | — | Dismiss through Escape, backdrop, or close button |
| `Modal.wide` | `boolean` | No | `false` | Apply the wider dialog class |

Use these imports from another file inside `src/`:

```jsx
import { Avatar, Button, Modal, SourceLink, Status } from './ui';

export function DirectionReceipt({ onOpenSource }) {
  return (
    <article>
      <Avatar name="Maya" />
      <p>Maya asked Codex to reuse the original payment key.</p>
      <Status>Delivered to Codex · turn 4</Status>
      <SourceLink onClick={onOpenSource}>Inspect delivery record</SourceLink>
    </article>
  );
}

export function SourceDialog({ onClose, onOpenReview }) {
  return (
    <Modal title="Delivery record" onClose={onClose}>
      <p>Maya's direction was delivered to Codex for turn 4.</p>
      <p>This record is sample data in the frontend prototype.</p>
      <Button onClick={onOpenReview}>Open review</Button>
    </Modal>
  );
}
```

Keep the receipt tied to its source in a connected implementation. These example messages illustrate content anatomy, not a delivery API.

### Screen integration hooks

`src/management-screens.jsx` exports complete screens. Two optional hooks preserve the distinction between a standalone specimen and the app shell:

| Prop | Type | Default | Behavior |
| --- | --- | --- | --- |
| `SetupScreen.onStartSolo` | `() => void` | `undefined` | Called after the user completes sample setup and starts a solo task. The app supplies task creation and navigation; without the hook, the screen keeps a local completion state and optionally calls `onToast`. |
| `ApprovalScreen.disabled` | `boolean` | `false` | Disables pending decision actions when the current user lacks an applicable grant. The parent also considers task access and turn eligibility. |
| `ApprovalScreen.hostStatus` | `'connected' \| 'disconnected' \| 'reconnecting'` | `'connected'` | Independently disables pending actions and displays connection-specific copy when the execution host is unavailable. |

The approval screen calls `onDecide('approved')` or `onDecide('declined')`; its parent owns the settled result. An `approval.status` of `expired` replaces the decision buttons with an explanation tied to the earlier turn. These hooks do not perform provider execution or enforce backend access rules.

## Motion and interaction

Use a short opacity/position entrance and quiet hover feedback. Shared controls use 200ms transitions; management controls use 180ms. App screen entrances use 320ms, 35ms stagger, and 7px travel. Gallery templates reveal over 350ms with 12px travel; their links shift 2px on hover. Motion must not move a decision button while a user is reading or reviewing code. Keep scroll-driven showcase effects inside the template gallery, away from operational controls.

Standard shared buttons are at least 38px tall; compact breadcrumb and icon actions are smaller. Aim for 44px touch targets in new touch-facing controls. Contrast ratios and target sizes in the tokens are design targets, not a claim that every existing element has been audited.

Respect `prefers-reduced-motion`: remove nonessential movement and preserve immediate access to all content. A hover effect must have an equivalent focus state. A progress animation cannot replace text such as “Interrupt requested” or “Host disconnected.”

## Adding a screen

For production changes, apply these rules in `apps/web/` through [AGENT-DEVELOPMENT.md](AGENT-DEVELOPMENT.md). The query mapping and component examples below describe the optional reference preview.

1. Choose the closest contract and identify its required slots. Reuse `shell` before inventing navigation.
2. Create content with actor, time, scope, and source information. Define the empty, pending, settled, and unavailable states that apply.
3. Build with the shared primitives, local font, and app tokens. Keep one primary action per decision area.
4. Add the screen to the navigation and query mapping. Update the template catalog if the new screen introduces a reusable pattern.
5. Inspect it at the desktop reference size and a narrow viewport. Check keyboard focus, modal closing, long content, local code overflow, and reduced motion.
6. Confirm that labels distinguish responsibility, execution, delivery, help, approval, and project access. Keep sample behavior clearly identified.

Do not add decorative statistics, invented security badges, marketing CTAs, or a scroll sequence to the task workspace. The design should make a teammate's next action clear.

## Project-centered alpha extension — 2026-09-15

Issues #65/#66 extend the accepted identity with the founder-approved Mutex-inspired interaction structure. Production uses a project rail, a project-filtered task list/feed and one shared task composer. On desktop above 1100px, the selected encrypted task places its conversation on the left of recorded results. At 1100px and below, the existing results view and explicit discussion drawer remain; at 760px and below, navigation remains a drawer. No general chat, automatic push/sync, preview orchestration or project-wide scheduler is introduced.

The `workspace` screen reuses `shell`; `setup` reuses `shell` + `setup`; selected work preserves all `review`/`decision` slots. Setup progress derives team, host verification/connectivity, selected project and advertised configured Codex state. A local login is not a configured execution capability. Retry and cancellation retain existing setup. A browser directs host-local steps to the desktop owner.

Project/task navigation remembers only opaque encrypted IDs in session storage scoped to account and team, validates them against currently available objects, and restores the selected task through authenticated replay. A draft cannot be sent after changing its project or host. Home-feed status is labeled as last read; selecting a task refreshes its verified history. Host connectivity is shown separately from task state and responsibility.

The original captures under `design/qa/` remain unchanged. Additional production evidence lives in `design/qa/alpha/` and the current validation record is `docs/proofs/project-workspace-alpha.md` at repository root. These captures document the intentional layout extension, not blanket approval of all product states.
