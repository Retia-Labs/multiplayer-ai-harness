# Plexus design contract and reference prototype

This repository contains the accepted **Review together** visual direction, six reusable template contracts, nine reference screens, and an optional interactive preview. Use them when developing the shared desktop/browser UI in [apps/web/](../../../apps/web/), alongside the authoritative [product specification](../../planning/product-spec.md).

The root [AGENTS.md](../../../AGENTS.md) directs coding agents to [AGENT-DEVELOPMENT.md](AGENT-DEVELOPMENT.md); [CLAUDE.md](../../../CLAUDE.md) points to the same instructions. References are installed in this checkout. No production UI migration is included in this pack.

## Use the references

Start with [AGENT-DEVELOPMENT.md](AGENT-DEVELOPMENT.md), then identify the screen, template IDs, shared components, required states, and accepted captures for the ticket. [DEVELOPMENT-HANDOFF.md](DEVELOPMENT-HANDOFF.md) maps the first production slice to the current renderer and protocol. Shared-component extraction and visual regression gates remain implementation work.

From the repository root, `npm run check:design` checks the reference pack and instruction wiring. Run it locally; GitHub Actions is disabled for this repository. It does not test rendered appearance or production behavior and does not configure required branch protection. Keep existing harness behavior checks in the implementation workflow.

## Optional isolated preview

Use Node.js **20.19 or newer within Node 20, or 22.12 or newer**, with npm. The installed `@vitejs/plugin-react` declares `^20.19.0 || >=22.12.0`; Node 22.22.3 is the local runtime used for this prototype. Run the following from the repository root to install and start the reference preview:

```sh
cd docs/design/plexus
npm ci
npm run dev -- --host 127.0.0.1 --port 4173
```

The following commands belong to this nested preview, not the repository root:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked prototype dependencies |
| `npm run dev -- --host 127.0.0.1 --port 4173` | Start the local Vite preview |
| `npm run build` | Build the frontend and prepare the existing Sites output layout |
| `npm run preview -- --host 127.0.0.1 --port 4173` | Preview a completed build |
| `npm run test:sites` | Run the existing Sites worker contract tests |

The initial screen is review. The local preview is `http://127.0.0.1:4173/`; select screens through navigation or the `screen` query parameter.

| Screen | Query | Main purpose |
| --- | --- | --- |
| Review together | `?screen=review` | Inspect a read-only diff and send an attributed correction |
| Workspace | `?screen=workspace` | Understand tasks, responsibility, and execution context |
| Activity | `?screen=activity` | Inspect attributed events and supporting sources |
| Catch up | `?screen=catchup` | Read a concise account of recent work with evidence |
| Inbox | `?screen=inbox` | Find human help requests and decisions needing attention |
| Approval | `?screen=approval` | Review one action's scope and make a sample decision |
| Setup | `?screen=setup` | Explore workspace, host, and provider setup concepts |
| Access | `?screen=access` | Explore project membership and access concepts |
| Templates | `?screen=templates` | Browse the reusable design patterns and guidance |

## Prototype boundaries

This is a React/Vite frontend demo with sample tasks, people, events, file changes, and results. Interactive controls update sample UI state. Reloading resets that state.

There is no implemented authentication, backend database, provider execution, command delivery, encryption, invitation delivery, access enforcement, or cross-device synchronization. Sample “delivered,” “approved,” “connected,” and check-result states demonstrate the intended experience; they do not prove that an external action occurred. Setup and security-related screens describe concept behavior.

The React/Vite preview is isolated under `docs/design/plexus/`. Its dependencies and build do not replace the root package or the renderer loaded by Electron. It retains the original Sites worker and output arrangement for optional preview packaging; a successful build does not publish a site. Do not commit its `node_modules/` or `dist/`.

## Design and implementation

| File | Role |
| --- | --- |
| [design/selected-direction.png](design/selected-direction.png) | Selected visual reference |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) | Layout, visual rules, shared components, and semantic requirements |
| [DEVELOPMENT-HANDOFF.md](DEVELOPMENT-HANDOFF.md) | Review-first adoption plan, shared UI/runtime boundaries, and team alignment checklist |
| [AGENT-DEVELOPMENT.md](AGENT-DEVELOPMENT.md) | Agent instructions, a reusable task prompt, and the checks needed to enforce the design in production |
| [design-qa.md](design-qa.md) | Imported prototype comparison and interaction evidence from 2026-09-06; not a production UI test report |
| [design/plexus-app.tokens.json](design/plexus-app.tokens.json) | Portable brand and app design values |
| [design/screen-templates.json](design/screen-templates.json) | Machine-readable slots, states, and rules for six reusable templates |
| [src/App.jsx](src/App.jsx) | App shell, navigation, and local interaction state |
| [src/ui.jsx](src/ui.jsx) | Shared UI primitives |
| [src/styles.css](src/styles.css) | App styling and responsive layout |
| [src/management-screens.jsx](src/management-screens.jsx) | Workspace, inbox, approval, setup, and access screens |
| [src/templates.jsx](src/templates.jsx) | Template specimens, contract inspection, and exports |
| [AGENTS.md](AGENTS.md) | Instructions for edits inside this isolated preview |

Use [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md#adding-a-screen) when extending the prototype. Preserve the distinction between a responsible person and an execution host, human help and agent input, connection and turn state, and a one-action approval and broader access.

The template gallery reads the JSON contracts directly. Its downloads use copies under `public/exports/`; refresh those copies when changing the tokens, contracts, design guide, or development handoff.
