# AgentPlex

Multi-session desktop orchestrator for Claude, Copilot, Codex, and shell sessions, with graph-based visualization and live session metadata (sub-agents, plans, tasks, HITL state).

## Stack

- Electron 41, Node.js 20+
- React 19, React Flow 12, Zustand 5, Tailwind 4, xterm.js 6
- node-pty for terminal sessions
- Vite 8, TypeScript 6, electron-forge 7, pnpm 10

## Runtime Architecture

1. **Session lifecycle**: `session-manager.ts` spawns PTYs, streams output via IPC, tracks status, and persists resumable sessions in `~/.agentplex/state.json`.
2. **Resume parity**: Claude and Copilot both support launcher-based resume and restart restore via `resumeSessionId`.
3. **Sub-agent tracking**: `jsonl-session-watcher.ts` tails both:
   - Claude: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
   - Copilot: `~/.copilot/session-state/<uuid>/events.jsonl`
4. **Plan/task tracking**:
   - Claude: `plan-task-detector.ts` parses terminal output.
   - Copilot: watcher maps `session.plan_changed` and derives task lists from SQL todo operations in events.
5. **HITL detection**:
   - Prompt pattern detection from terminal output (generic)
   - Copilot permission events (`permission.requested/completed`) for fast waiting-state updates.
6. **Cross-session messaging**: `SendDialog.tsx` sends raw buffer context or an optional summary: GitHub Copilot (`copilot-summary-proxy.ts`) for Copilot sources, Anthropic Haiku (`AGENTPLEX_API_KEY`) for others. Targets are live, writable sessions other than the source (`isSendTarget()` in `store.ts`), and the node's send button is disabled when there are none.
7. **Duplicate Session**: `SessionManager.fork()` (IPC `session:fork`, `window.agentPlex.forkSession`) starts a Claude session with `--resume <source> --fork-session --session-id <new uuid>`, so the copy persists and restores like any other session. A source with no conversation yet gets an empty Claude session in the same directory. Non-Claude sessions can't be duplicated. `SessionNode.tsx` adds the copy to the source's group (read once the fork finishes) with `addToGroup(..., { reposition: true })`, covered by `session-node-e2e.cjs`.

## Key Main-Process Files

- `src/main/session-manager.ts`: PTY spawn/kill, resume, fork, restore, status loop, external adoption
- `src/main/jsonl-session-watcher.ts`: Claude/Copilot event parsing for sub-agent/plan/task/HITL signals
- `src/main/claude-session-scanner.ts`: Claude project/session discovery + transcript rendering
- `src/main/copilot-session-scanner.ts`: Copilot project/session discovery + transcript rendering
- `src/main/ipc-handlers.ts`: renderer bridge for sessions, launcher, git, settings, templates
- `src/main/preview-navigation.ts`: navigation guard on the main window. It denies new windows, blocks every page-initiated navigation except reloading the app page itself, and limits subframes to `about:srcdoc`/`about:blank`. The reload exception matters in dev: Forge sends Vite a `full-reload` when the preload builds, including right after launch, and cancelling that reload mid-load left the window empty. Covered by `scripts/preview-navigation.test.cjs`.

## UI Data Flow

- `App.tsx` subscribes to IPC events and updates Zustand store.
- `store.ts` is the source of truth for sessions, nodes, edges, plans, tasks, and sub-agents.
- `SessionNode.tsx` and `SubAgentNode.tsx` render live session/task/sub-agent state on the graph.
- Grouping by drag: `resolveDrop()` in `group-drop.ts` (kept out of `GraphCanvas.tsx` so that file only exports components, which Fast Refresh needs) decides what releasing a dragged session does (join, leave, stay in a group, or pair with another session). It runs on every drag move to set `groupDragHint` in the store, which `GroupNode.tsx` shows as a blue (join) or red (leave) outline, and again on drop to apply the change. The colors are the per-theme tokens `--join-group` and `--leave-group` in `styles/index.css`.
- Shared-directory groups: `groupSharedDirectory()` in `store.ts` returns the working directory all of a group's sessions share (ignoring trailing separators, and case and slash direction on Windows), or null. `GroupNode.tsx` then shows it under the group name and sets `data-shared-directory` on the circle. Double-clicking such a circle calls `createSession(directory, groupSessionCli(...))` and `addToGroup(id, newId, { center })` to place the card at the click point. `groupSessionCli()` returns the members' shared CLI with `-resume` stripped, or `claude`. The circle also gets `nopan` so React Flow's double-click zoom doesn't fire; a pending ref stops repeat double-clicks from starting two sessions. The label's own double-click (rename) stops propagation.
- Group color: right-clicking the dot (`.graph-group__swatch`) in a group's label opens a picker with `GROUP_COLORS` plus a custom `<input type="color">`, which calls `setGroupColor()`. The color lives in the group node's `data.color` and is saved through the existing groups persistence (`serializeGroups`).
- Group resize: there is no resize box. Dragging the circle's edge (an SVG ring in `GroupNode.tsx`, marked `nodrag` so React Flow doesn't move the group) calls `resizeGroup(id, size, { recenter: true, keepMembersInPlace: true })`. That keeps the center and the member cards fixed and sets `manualSize`, which turns off auto-fit.
- Canvas layout persistence: `~/.agentplex/groups.json` (`PersistedGroups`) holds the whole canvas layout. That's groups (label, color, `manualSize`, `center`, member positions), `sessions` (ungrouped card positions) and `viewport` (pan/zoom, recorded on React Flow's `onMoveEnd`). `App.tsx` writes it through `serializeGroups()`, 500 ms after any change to nodes, sessions or viewport, and flushes on `beforeunload`. `restoreGroups()` applies it on startup, matching saved entries to live sessions by resume UUID (or id plus start time after a renderer reload), and hands the viewport to `GraphCanvas` through `restoredViewport`. `GraphCanvas` applies it only once `useNodesInitialized()` is true, because React Flow's `fitView` prop fits the graph when the cards are first measured and would otherwise override the saved zoom. Any resize during restore must pass `keepMembersInPlace`, or members drift on every restart (covered by `scripts/canvas-layout.test.cjs`). Session names and the session list live in the main process's `state.json`; drawings are saved separately. New visible canvas state should be added to this file.
- `GraphCanvas.tsx` sets `deleteKeyCode={null}`, so keyboard deletion of selected nodes is turned off. Remove sessions and groups through their own actions.
- Group tests: `scripts/group-features.test.cjs` covers `resolveDrop()`, the drag hint, the canvas props (`deleteKeyCode`, viewport, including waiting for measured cards before applying a restored viewport), `groupSharedDirectory()`, `setGroupColor()`, edge resize and the `--join-group`/`--leave-group` tokens. `scripts/desktop-replay.test.cjs` covers the autosave debounce and `beforeunload` flush. `scripts/group-node-e2e.cjs` renders the real `GroupNode` for the outline, shared-directory line, color picker and edge resize. Extend these when changing group behavior.

## Commands

```bash
pnpm install
pnpm start          # production build, reused until sources change
pnpm dev            # live reload; type `rs` in its terminal to restart the main process
pnpm lint
pnpm test           # node:test suites in scripts/*.test.cjs
pnpm exec tsc --noEmit
node scripts/run-git-editor-e2e.cjs <script>   # Electron e2e, e.g. send-dialog-e2e.cjs, session-node-e2e.cjs, group-node-e2e.cjs
pnpm package
pnpm make
```

## Documentation

Every change to the project needs a matching documentation update in the same change. That covers features, behavior, commands, configuration, file layout and tests. Update whichever of `README.md` and `CLAUDE.md` the change affects. If a change truly affects no documentation, say so explicitly rather than skipping the check.

## Repository

This repository (`BorisKozo/agentplex`) is based on `AlexPeppas/agentplex` but is developed independently. Pull requests target this repository's `master`; never push to, or open pull requests against, the original project.
