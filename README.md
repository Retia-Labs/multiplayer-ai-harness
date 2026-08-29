# Codex Desktop Clone

A working clone of the OpenAI **Codex desktop app**, built with Electron. It reproduces the
core experience: a thread sidebar, a project workspace, an agentic chat loop that runs real
shell commands with approval modes, and a git **Changes** diff viewer.

![Screenshot](docs/screenshot.png)

## Features

- **Threads** — persistent conversation threads, grouped by date (Today / Yesterday / …),
  searchable, auto-titled from the first message.
- **Projects** — open any folder as the workspace; the top bar shows the git branch and a
  dirty indicator, and all agent commands run inside the project directory.
- **Agentic chat** — a real agent loop with a `shell` tool:
  - With an **OpenAI API key** (Settings → gear icon), messages go to the Chat Completions
    API with streaming and function calling; the model can run commands, read output, and
    iterate up to 24 tool turns.
  - Without a key, a built-in **demo agent** streams simulated replies and still runs real
    read-only commands through the same tool pipeline, so the whole UI is exercisable offline.
- **Approval modes** — like the real app:
  - `Read Only`: only safe inspection commands (ls, cat, git status, …) are allowed.
  - `Agent`: safe commands auto-run; anything else shows an inline **Approve / Deny** card.
  - `Agent (Full Access)`: everything auto-runs.
- **Command cards** — live-streaming collapsible cards with status dots
  (running / succeeded / failed / denied).
- **Changes panel** — parsed working-tree diff (including untracked files) with per-file
  add/delete counts and colored hunks.
- **Model picker**, **Stop** button for in-flight turns, markdown rendering,
  dark/light themes, and settings persisted to disk.

## Run it

```bash
npm install
npm start
```

On a headless machine: `xvfb-run -a npm start`.

## Test it

An end-to-end smoke test launches the real app with Playwright, creates a scratch git repo,
drives the UI (send message → agent runs commands → diff panel → settings), and takes the
README screenshot:

```bash
xvfb-run -a npm run smoke
```

## Layout

```
src/main/main.js      Electron main process + IPC wiring
src/main/store.js     Settings & thread persistence (JSON in userData)
src/main/agent.js     Agent loop: OpenAI backend, demo backend, tool exec + approvals
src/main/gitutils.js  Branch/status/diff helpers + diff parser
src/main/preload.js   contextBridge API exposed to the renderer
src/renderer/         UI (vanilla JS, no build step): index.html, styles.css, app.js, markdown.js
test/smoke.js         Playwright end-to-end smoke test
```

## Notes

- Not affiliated with OpenAI; this is a functional homage for experimentation.
- The API key is stored locally in `userData/settings.json` and only sent to the base URL
  you configure (default `https://api.openai.com/v1`).
