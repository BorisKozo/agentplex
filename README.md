<p align="center">
  <img src="assets/logo.svg" alt="AgentPlex" width="80" />
</p>

<h1 align="center">AgentPlex</h1>

<p align="center">
  Multi-session Claude/Codex/GitHub Copilot CLI orchestrator with graph visualization.
</p>

<p align="center">
  <a href="#build-from-source"><strong>Build from source</strong></a> &nbsp;|&nbsp;
  <a href="#development">Development</a>
</p>

> **About this project:** this repository is based on [AlexPeppas/agentplex](https://github.com/AlexPeppas/agentplex), but it is developed independently and is going in a different direction. Changes here are not contributed back to the original project, and the two may diverge in features and behavior.

---

## Requirements

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- [GitHub CLI](https://cli.github.com/) with Copilot extension (`gh copilot`) installed and authenticated

## Quick Start

This project doesn't publish pre-built installers yet, so [build from source](#build-from-source) on Windows, macOS or Linux. When releases are published, they'll appear on this repository's [Releases](https://github.com/BorisKozo/agentplex/releases) page.

## Installation

<a id="build-from-source"></a>

Clone the repository, install dependencies, and start the app:

```bash
git clone https://github.com/BorisKozo/agentplex.git
cd agentplex
pnpm install
pnpm start
```

`pnpm start` builds the application once and reuses that production build on
unchanged launches. Source, asset, configuration, environment-file, or lockfile
changes trigger a rebuild; missing or modified build outputs are rebuilt too.
The global `agentplex` command uses the same launcher. Build files stay in
the ignored `.vite` directory; saved sessions are not part of the build cache.

For development with live reload, use `pnpm dev` instead (see [Development](#development)).

To build a distributable installer:

```bash
pnpm make
```

### Updating a source checkout

After pulling changes, install the dependencies before starting AgentPlex:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm start
```

`git pull` updates the source and lockfile, but does not install new dependencies.
Run the install command in each checkout or worktree you launch, even if it
already has a `node_modules` directory.

### Troubleshooting: startup build failures

If startup reports missing dependencies, or `pnpm dev` finishes building preload
but stays at `Building ... main.ts target`,
the checkout may be missing a newly added dependency such as `sanitize-html`.
Cancel only the stalled startup command with Ctrl+C, then run:

```bash
pnpm install --frozen-lockfile
pnpm start
```

Startup now checks runtime dependency entry points before launching the build
and reports missing or incomplete packages with these recovery commands.
If installation fails, address the reported installation error before retrying
startup. This recovery does not require deleting session data or resetting
configuration. These instructions apply to source checkouts, not the packaged EXE.

### Global CLI shortcut (optional)

```bash
pnpm link --global   # one-time setup
agentplex            # launch from anywhere
```

To remove: `pnpm unlink --global agentplex`

### Native file previews

Open a file from the session workspace tree, or click a supported local file path
in terminal output, to preview it in a read-only session tab. Markdown links can
also open other local files within the session workspace.

| Files | Preview |
| --- | --- |
| `.md`, `.markdown` | Formatted Markdown, tables and fenced Mermaid diagrams |
| `.json` | Formatted JSON with explicit parse errors |
| `.html`, `.htm` | Sandboxed HTML with scripts, navigation and network resources disabled |
| `.pdf` | Native PDF reader with page navigation and zoom |
| `.csv`, `.tsv` | Scrollable tables preserving quoted and multiline values |
| `.docx` | Word headings, paragraphs, lists and tables; not exact page layout |
| `.doc` | Legacy Word text, including headers, footers and notes; no original page layout |
| `.xlsx` | Workbook sheet tabs and cell values; formulas show saved results and are never calculated |
| `.mmd`, `.mermaid` | Locally rendered Mermaid diagram with a source toggle |
| `.txt`, `.log`, `.yaml`, `.yml`, `.xml`, `.toml`, `.ini`, `.conf`, `.config`, `.jsonl`, `.ndjson` | Plain text |
| Common source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.cs`, `.css`, `.sql`, `.sh`, `.ps1`, etc.) | Read-only source text, never executed |

Text files are limited to **1 MiB**, decoded as UTF-8 or BOM-marked UTF-16.
PDF and Office input files are limited to **20 MiB**. Office conversion runs in
bounded background workers with a 15-second timeout; ZIP-based Office documents
are limited to 2,000 archive entries and 40 MiB of expanded content. Extracted
Word output is limited to 2 MiB.

Table previews show at most 1,000 rows and 100 columns per sheet, 20 sheets and
20,000 cells total; a notice identifies truncated previews. Word images, embedded
objects and active links are disabled. Encrypted documents and legacy `.xls`
workbooks are not supported. Mermaid configuration directives, interactive links
and network references are disabled; diagrams are limited to 50,000 characters
and 500 edges. Unsupported, malformed and oversized files show an explicit error.

Previews remain scoped to the selected workspace and that session's artifact
directory. They do not require Microsoft Office or an external editor.

## Dev Requirements

Building from source requires [Node.js](https://nodejs.org/) 20+ and native build tools for `node-pty`:

- **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++"
- **macOS**: `xcode-select --install`
- **Linux**: `sudo apt install build-essential python3`

pnpm is pinned via `packageManager` in package.json. If you have [corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`), it will auto-install the correct version. Otherwise install pnpm directly: `npm install -g pnpm`.

<a id="development"></a>

## Development

### Live reload

```bash
pnpm dev
```

`pnpm dev` runs Electron Forge with the Vite dev server:

| You edit | What happens |
| --- | --- |
| Renderer (`src/renderer/**`, `styles/`) | Hot-reloads in place |
| Preload (`src/preload/preload.ts`) | The window reloads automatically |
| Main process (`src/main/**`) | Rebuilt, then type `rs` in the dev terminal to restart |

Restarting the main process ends every running CLI session. Saved sessions are
restored on startup, but their terminals start fresh.

The window reloads itself right after launch (Forge's preload build sends a
reload) and whenever Vite asks for one, such as after pre-bundling dependencies
on the first `pnpm dev` in a checkout. If an edit doesn't show up, the file
watcher may have missed it: save the file again.

### Checks and tests

```bash
pnpm lint      # ESLint over src/
pnpm test      # node:test suites in scripts/*.test.cjs
```

The unit tests compile individual modules with the project's TypeScript and
replace native and Electron services with fakes, so they run without launching
the app. Type checking is not part of `pnpm test`; run it with
`pnpm exec tsc --noEmit`.

Electron end-to-end tests render real components in a hidden window. Run one at
a time through the runner, which creates an isolated temporary profile:

```bash
node scripts/run-git-editor-e2e.cjs send-dialog-e2e.cjs
```

Available scripts: `git-editor-e2e.cjs`, `send-dialog-e2e.cjs`,
`session-node-e2e.cjs`, `group-node-e2e.cjs`, `desktop-priorities-e2e.cjs`,
`workspace-artifacts-e2e.cjs`, `terminal-rendering-smoke.cjs` and
`copilot-runtime-smoke.cjs`.

## Features

- **Multi-session management** — run multiple Claude/Codex/Copilot CLI sessions side by side
- **Graph canvas** — drag, arrange, and connect session nodes on a visual canvas
- **HITL notifications** — get notified when a CLI session requires human input
- **Cross-session messaging** — send messages between sessions with optional GitHub Copilot or Haiku summarization
- **Duplicate Session** — fork a Claude session's conversation into a new session in the same directory
- **Sub-agent tracking** — visualize spawned sub-agents via JSONL transcript tailing
- **Plan & task visualization** — see plans and task lists rendered in the graph
- **Session resume** — resume previous Claude and Copilot sessions from the same launcher UX
- **External session adoption** — discover and adopt running Claude/Copilot sessions
- **Graphite dark / Stone light** — muted paired themes for the graph, explorers, and toolbar
- **Groups** — gather sessions into colored circles by dragging; the target circle highlights blue (join) or red (leave) before you drop. When every session in a group works in the same directory, the directory is shown under the group name, and double-clicking inside the circle starts a new session there. Right-click the colored dot next to a group's name to pick its color
- **Inline rename** — double-click any node to rename it
- **Panel position** — open session panes beside the canvas (side by side) or below it (stacked top to bottom), from **Settings → Panel position**; the choice persists across launches

Switch between Graphite and Stone in **Settings**; your choice persists across
launches. Terminal output and Git diff editors remain dark in both themes to
preserve CLI and code readability.

| Graphite (dark) | Stone (light) |
| --- | --- |
| ![Graphite session graph](assets/graphite-preview.png) | ![Stone session graph](assets/stone-preview.png) |
| [Workspace and file preview](assets/graphite-workspace-preview.png) | [Workspace and file preview](assets/stone-workspace-preview.png) |

> Captured from the production renderer with synthetic sessions and an isolated
> workspace. Click an image for the full-size view. Session cards show live state,
> waiting sessions use a diamond indicator, and the graph dock provides zoom and
> fit controls. Hover or keyboard-focus a card to reveal its actions.

## Configuration

### Cross-session summarization (optional)

When the source session is Copilot, summarization uses an enabled low-cost model from your GitHub Copilot account through an isolated inference-only SDK proxy. Authenticate with `gh auth login`, or supply `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. Copilot CLI must be installed. No Anthropic API key or HTTP proxy listener is required; Copilot account usage charges apply.

For other source CLIs, enable Haiku summarization by setting your Anthropic API key using `AGENTPLEX_API_KEY` (not `ANTHROPIC_API_KEY`, which would conflict with Claude CLI's auth).

**Set it persistently (recommended):**

```bash
export AGENTPLEX_API_KEY=sk-ant-...       # macOS/Linux (~/.bashrc or ~/.zshrc)
set AGENTPLEX_API_KEY=sk-ant-...          # Windows (cmd)
$env:AGENTPLEX_API_KEY="sk-ant-..."       # Windows (PowerShell)
```

**Or inline when launching from source:**

```bash
AGENTPLEX_API_KEY=sk-ant-... pnpm start                          # macOS/Linux
$env:AGENTPLEX_API_KEY="sk-ant-..."; pnpm start                  # Windows (PowerShell)
```

Without summarization credentials, cross-session messaging still works: uncheck summarization to send raw terminal context. Summary failures are shown in the send dialog and do not silently broadcast raw context. Summaries use the provider's persisted conversation, falling back to the terminal buffer when no conversation is available.

## Usage

1. **Create sessions** — click "+ New Session" and pick a working directory
2. **Arrange nodes** — drag session nodes freely on the canvas. The layout is saved automatically after every change (card and group positions, group names, colors and sizes, and the canvas pan and zoom) and comes back the same way after a restart
3. **Group** — drop a session onto another ungrouped session to form a group, or onto a group's circle to join it; drag a member outside the circle to remove it. While you drag, the circle shows what releasing will do: a blue outline means the session joins that group, a red outline means it leaves. A group you're dragging fills with its own color so you can tell which one is moving. If all of a group's sessions share one working directory, that directory appears under the group's name (hover it for the full path), and double-clicking an empty spot inside the circle starts a new session in that directory at that spot and adds it to the group. The new session uses the CLI all the members use (a resumed Claude or Copilot session counts as Claude or Copilot), or Claude if they differ. Double-clicking the group's name still renames it. To recolor a group, right-click the dot next to its name and choose a palette color or a custom one; the color is saved with the group. To resize a group, drag its circle's edge: the circle grows or shrinks around its center, the sessions stay put, and the group stops auto-fitting to its members. Backspace and Delete never remove nodes from the canvas
4. **Rename** — double-click a node label to rename it
5. **Send messages** — hover a node, click the send icon to share context with another session. The icon is disabled until another live, writable session is open; read-only discovered CLIs can't receive messages
6. **Duplicate** — hover a Claude node and click the Duplicate Session icon. The new session continues from a copy of the conversation (`claude --resume <id> --fork-session`) and the original is left unchanged. A session with no conversation yet opens an empty Claude session in the same directory. If the original is in a group, the copy joins that group
7. **Resume** — use "Resume" under Claude or Copilot to continue a previous session

The Explorer also provides a **Needs attention** box for sessions waiting for input.
Click an item to review its terminal; this does not automatically approve requests.
Search by session name, project path, CLI, or group, and combine status and CLI
filters. Projects and sessions stay alphabetically ordered as activity changes.
Session creation remains in the main toolbar and project context menus.

For Copilot, **Running** follows assistant turns and tool execution, **Needs
attention** means an unresolved permission or `ask_user` request, and **Idle**
means the turn has ended or been cancelled. Terminal prompt text, redraws, and
quiet periods during long-running work do not change Copilot's lifecycle status.

Copilot token readings are labeled **snapshot**: they come from the main
conversation's prompt-cache checkpoint, successful compaction, or CLI shutdown.
Hover for the exact count, source, and timestamp. Auxiliary model calls are
excluded. These snapshots can lag `/context`; no pressure percentage is shown
without a reliable context-window capacity.

Terminal fullscreen and split-pane resizing preserve the mounted terminal.
Desktop resizes wait for settled layout and queued output before synchronizing
the PTY and repainting. Windows sessions use the correct PTY compatibility
settings to preserve scrollback when the terminal grows.

Select terminal text and press **Ctrl+C** (Windows/Linux) or **Cmd+C** (macOS)
to copy. **Ctrl+Shift+C/V** also copies/pastes on Windows/Linux. If a CLI captures
mouse input, hold **Shift** while dragging to select text. Right-click copies
selected text; without a selection it pastes into writable sessions. Ctrl+C
without selected text still interrupts the CLI. Copying also works in read-only
discovered sessions.

CLI-native copy actions, including Copilot's `/copy` command, can write text to
the system clipboard through OSC 52 in visible, writable terminals. Clipboard
reads, saved-output replay, and read-only transcript monitors cannot access the
clipboard through terminal escape sequences. Clipboard writes are limited to
1 MiB of UTF-8 text.

## Project Structure

```
agentplex/
├── src/
│   ├── main/                          # Electron main process
│   │   ├── main.ts                    # App entry, window, CSP, single-instance lock
│   │   ├── application-instance.ts    # Native app lock shared by dev and packaged builds
│   │   ├── session-manager.ts         # PTY spawn/kill, resume, fork, restore, status loop, discovery
│   │   ├── ipc-handlers.ts            # Renderer bridge: sessions, launcher, git, settings, templates
│   │   ├── jsonl-session-watcher.ts   # Claude/Copilot event tailing (sub-agents, plans, tasks, HITL)
│   │   ├── plan-task-detector.ts      # Claude terminal parsing for plans and tasks
│   │   ├── claude-session-scanner.ts  # Claude project/session discovery and transcript rendering
│   │   ├── copilot-session-scanner.ts # Copilot project/session discovery and transcript rendering
│   │   ├── copilot-session-discovery.ts # Finds Copilot CLIs running outside AgentPlex
│   │   ├── copilot-lifecycle.ts       # Copilot running/idle/needs-attention state from events
│   │   ├── copilot-summary-proxy.ts   # Copilot-backed summaries for cross-session messages
│   │   ├── config-loader.ts           # Claude launcher command and flags
│   │   ├── settings-manager.ts        # Persisted app settings
│   │   ├── shell-detector.ts          # Available shells and versions
│   │   ├── git-operations.ts          # Git status, diff, stage, commit, push
│   │   ├── session-search.ts          # Search across saved Claude/Copilot sessions
│   │   ├── history-reader.ts          # Chunked reads of large transcript files
│   │   ├── workspace-files.ts         # Workspace tree listing and scoped file reads
│   │   ├── office-preview*.ts         # Sandboxed Word/Excel preview parsing in a worker
│   │   └── preview-navigation.ts      # Blocks navigation from preview content
│   ├── preload/
│   │   └── preload.ts                 # Context bridge (window.agentPlex)
│   ├── renderer/
│   │   ├── App.tsx                    # Root component; subscribes to IPC events
│   │   ├── store.ts                   # Zustand store: sessions, nodes, edges, plans, tasks
│   │   ├── group-drop.ts              # What dropping a dragged card does to groups
│   │   ├── components/
│   │   │   ├── GraphCanvas.tsx        # React Flow canvas
│   │   │   ├── SessionNode.tsx        # Session card with send/duplicate/rename/delete actions
│   │   │   ├── SubAgentNode.tsx, GroupNode.tsx
│   │   │   ├── SendDialog.tsx         # Cross-session messaging
│   │   │   ├── TerminalPanel.tsx      # xterm.js terminal panes
│   │   │   ├── GitDiffPanel.tsx       # Monaco-based diff and commit panel
│   │   │   ├── ProjectLauncher.tsx    # New/resume session launcher
│   │   │   ├── WorkspaceExplorer.tsx, ArtifactPreview.tsx, *Preview.tsx
│   │   │   ├── Toolbar.tsx, ActivityBar.tsx, SidePanel.tsx, AttentionBox.tsx
│   │   │   └── panels/                # Explorer, Search, Templates, Settings
│   │   ├── hooks/                     # useTerminal, useViewportMenu
│   │   └── session-explorer.ts, terminal-resize.ts
│   └── shared/                        # Used by main and renderer
│       ├── ipc-channels.ts            # IPC channel names and shared types
│       ├── ansi-strip.ts, conversation-identity.ts
│       └── artifact-formats.ts, artifact-links.ts
├── scripts/
│   ├── start.mjs, startup-cache.mjs   # pnpm start launcher with build reuse
│   ├── *.test.cjs                     # Unit tests (pnpm test)
│   ├── *-e2e.cjs, *-smoke.cjs         # Electron end-to-end tests
│   └── run-git-editor-e2e.cjs         # Runner for the Electron tests
├── styles/index.css                   # Global styles and themes
├── bin/agentplex.mjs                  # Global `agentplex` command
├── forge.config.ts                    # Electron Forge packaging
└── package.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Electron](https://www.electronjs.org/) |
| UI framework | [React](https://react.dev/) |
| Graph canvas | [React Flow](https://reactflow.dev/) |
| Terminal | [xterm.js](https://xtermjs.org/) |
| State | [Zustand](https://zustand-demo.pmnd.rs/) |
| PTY backend | [node-pty](https://github.com/microsoft/node-pty) |
| Summarization | [Anthropic SDK](https://docs.anthropic.com/en/docs/sdks) (optional) |

## License

[MIT](LICENSE)
