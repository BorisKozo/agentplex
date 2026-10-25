import { ipcMain, dialog, shell, BrowserWindow, app, clipboard } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC, CLI_TOOLS, RESUME_TOOL, COPILOT_RESUME_TOOL, type CliTool, type PinnedProject, type DrawingData, type WorkspaceTemplate, type PersistedGroups } from '../shared/ipc-channels';
import { ensureGlobalConfig, ensureProjectConfig } from './config-loader';
import { sessionManager } from './session-manager';
import { detectShells, getCachedShells } from './shell-detector';
import { getDefaultShellId, setDefaultShellId } from './settings-manager';
import {
  scanProjects as scanClaudeProjects,
  scanSessionsForProject as scanClaudeSessionsForProject,
  getPinnedProjects,
  updatePinnedProjects,
  resolveProjectPath,
} from './claude-session-scanner';
import {
  scanProjects as scanCopilotProjects,
  scanSessionsForProject as scanCopilotSessionsForProject,
} from './copilot-session-scanner';
import { searchSessions } from './session-search';
import type { HistoryRequestKind } from '../shared/ipc-channels';
import { getGitStatus, getFileDiff, saveFile, stageFile, unstageFile, stageAll, unstageAll, gitCommit, gitPush, gitPull, gitLog, gitBranchInfo } from './git-operations';
import { listWorkspaceDirectory, readWorkspaceFile } from './workspace-files';

const VALID_CLI_IDS = new Set<string>([
  ...CLI_TOOLS.map((t) => t.id),
  RESUME_TOOL.id,
  COPILOT_RESUME_TOOL.id,
]);

function isValidCli(id: string): boolean {
  return VALID_CLI_IDS.has(id) || getCachedShells().some((s) => s.id === id);
}

export function registerIpcHandlers() {
  ipcMain.handle(IPC.CLIPBOARD_WRITE, (event, text: string) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Clipboard access requires the application frame');
    if (typeof text !== 'string') throw new Error('Clipboard text must be a string');
    return clipboard.writeText(text);
  });
  ipcMain.handle(IPC.CLIPBOARD_READ, event => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Clipboard access requires the application frame');
    return clipboard.readText();
  });
  function workspace(sessionId: string): string {
    if (typeof sessionId !== 'string') throw new Error('Session ID must be a string');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session has no workspace');
    return cwd;
  }
  ipcMain.handle(IPC.WORKSPACE_LIST, (_event, { sessionId, directory = '' }: { sessionId: string; directory?: string }) => {
    if (typeof directory !== 'string') throw new Error('Directory must be a string');
    return listWorkspaceDirectory(workspace(sessionId), directory);
  });
  ipcMain.handle(IPC.WORKSPACE_READ, (_event, { sessionId, reference }: { sessionId: string; reference: string }) => {
    if (typeof reference !== 'string') throw new Error('File reference must be a string');
    const cwd = workspace(sessionId);
    const session = sessionManager.list().find(info => info.id === sessionId);
    const jsonl = sessionManager.getJsonlPath(sessionId);
    const artifacts = jsonl && session?.cli === 'copilot' ? path.join(path.dirname(jsonl), 'files') : undefined;
    return readWorkspaceFile(cwd, reference, artifacts);
  });
  ipcMain.handle(IPC.OPEN_EXTERNAL, (_event, { url }: { url: string }) => {
    if (typeof url !== 'string') throw new Error('URL must be a string');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only HTTP(S) links may open externally');
    return shell.openExternal(parsed.href);
  });
  const pendingHistory = new Map<string, AbortController>();
  async function runHistory<T>(
    event: Electron.IpcMainInvokeEvent,
    kind: HistoryRequestKind,
    operation: (signal: AbortSignal) => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${event.sender.id}:${kind}`;
    pendingHistory.get(key)?.abort();
    const controller = new AbortController();
    pendingHistory.set(key, controller);
    const cancel = () => controller.abort();
    event.sender.once('destroyed', cancel);
    try {
      return await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    } catch (error) {
      if (controller.signal.aborted) return [];
      console.error(`[history] ${kind} failed:`, error);
      throw error;
    } finally {
      controller.abort();
      event.sender.removeListener('destroyed', cancel);
      if (pendingHistory.get(key) === controller) pendingHistory.delete(key);
    }
  }
  ipcMain.on(IPC.HISTORY_CANCEL, (event, { kind }: { kind: HistoryRequestKind }) => {
    pendingHistory.get(`${event.sender.id}:${kind}`)?.abort();
  });

  ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd, cli, resumeSessionId }: { cwd?: string; cli?: string; resumeSessionId?: string } = {}) => {
    const safeCli: CliTool = (cli && isValidCli(cli) ? cli : 'claude') as CliTool;
    return sessionManager.create(cwd, safeCli, resumeSessionId);
  });

  ipcMain.handle(IPC.SESSION_FORK, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') throw new Error('Invalid session id');
    return sessionManager.fork(id);
  });

  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select working directory for Claude session',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.on(IPC.SESSION_WRITE, (_event, { id, data }: { id: string; data: string }) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    sessionManager.write(id, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    if (typeof id !== 'string') return;
    const safeCols = Math.max(1, Math.min(500, Math.floor(Number(cols) || 80)));
    const safeRows = Math.max(1, Math.min(200, Math.floor(Number(rows) || 24)));
    sessionManager.resize(id, safeCols, safeRows);
  });

  ipcMain.handle(IPC.SESSION_KILL, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return;
    sessionManager.kill(id);
  });

  ipcMain.handle(IPC.SESSION_LIST, () => {
    return sessionManager.list();
  });

  ipcMain.handle(IPC.SESSION_GET_BUFFER, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return '';
    return sessionManager.getBuffer(id);
  });

  ipcMain.handle(IPC.SESSION_GET_BUFFER_SNAPSHOT, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') throw new Error('Session ID must be a string');
    return sessionManager.getBufferSnapshot(id);
  });

  ipcMain.handle(IPC.SESSION_GET_CWD, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return null;
    return sessionManager.getCwd(id);
  });

  ipcMain.on(IPC.SESSION_UPDATE_STATE, (_event, { sessionId, displayName }: { sessionId: string; displayName: string }) => {
    if (typeof sessionId !== 'string' || typeof displayName !== 'string') return;
    sessionManager.updateDisplayName(sessionId, displayName.slice(0, 200));
  });

  ipcMain.handle(IPC.SESSION_RESTORE_ALL, () => {
    return sessionManager.restoreAll();
  });

  ipcMain.handle(IPC.DISCOVER_EXTERNAL, (event) => {
    return runHistory(event, 'external', signal => sessionManager.discoverExternal(signal));
  });

  ipcMain.handle(IPC.ADOPT_EXTERNAL, (_event, { sessionUuid, cwd, cli }: { sessionUuid: string; cwd: string; cli?: 'claude' | 'copilot' }) => {
    if (typeof sessionUuid !== 'string' || typeof cwd !== 'string') {
      throw new Error('Invalid parameters');
    }
    const safeCli = cli === 'copilot' ? 'copilot' : 'claude';
    return sessionManager.adoptExternal(sessionUuid, cwd, safeCli);
  });

  ipcMain.handle(IPC.DISPLAY_NAMES_GET, () => {
    return sessionManager.getDisplayNames();
  });

  const THEME_COLORS: Record<string, { titleBar: string; symbol: string; bg: string }> = {
    dark: { titleBar: '#181c20', symbol: '#e4e8ed', bg: '#181c20' },
    light: { titleBar: '#f3f1ec', symbol: '#30332f', bg: '#f3f1ec' },
  };

  ipcMain.handle(IPC.LAUNCHER_SCAN_PROJECTS, async (event, { cli }: { cli?: 'claude' | 'copilot' } = {}) => {
    const safeCli = cli === 'copilot' ? 'copilot' : 'claude';
    console.log('[launcher] scanProjects called for', safeCli);
    return runHistory(event, 'projects', async signal => {
      const result = safeCli === 'copilot'
        ? await scanCopilotProjects(signal)
        : await scanClaudeProjects(signal);
      console.log('[launcher] scanProjects done:', result.length, 'projects');
      return result;
    });
  });

  ipcMain.handle(IPC.LAUNCHER_SCAN_SESSIONS, async (event, { encodedPath, cli }: { encodedPath: string; cli?: 'claude' | 'copilot' }) => {
    if (typeof encodedPath !== 'string') return [];
    return runHistory(event, 'sessions', signal => cli === 'copilot'
      ? scanCopilotSessionsForProject(encodedPath, signal)
      : scanClaudeSessionsForProject(encodedPath, signal));
  });

  ipcMain.handle(IPC.LAUNCHER_GET_PINS, () => {
    return getPinnedProjects();
  });

  ipcMain.handle(IPC.LAUNCHER_UPDATE_PINS, (_event, { pins }: { pins: PinnedProject[] }) => {
    if (!Array.isArray(pins)) return;
    updatePinnedProjects(pins);
  });

  ipcMain.handle(IPC.LAUNCHER_RESOLVE_PATH, async (_event, { encodedPath }: { encodedPath: string }) => {
    if (typeof encodedPath !== 'string') return null;
    return resolveProjectPath(encodedPath);
  });

  ipcMain.handle(IPC.SESSION_SEARCH, async (event, { query }: { query: string }) => {
    if (typeof query !== 'string') return [];
    return runHistory(event, 'search', signal => searchSessions(query, signal));
  });

  ipcMain.on(IPC.THEME_CHANGE, (event, { theme }: { theme: string }) => {
    const colors = THEME_COLORS[theme];
    if (!colors) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: colors.titleBar,
        symbolColor: colors.symbol,
      });
    }
    win.setBackgroundColor(colors.bg);
  });

  ipcMain.handle(IPC.SHELL_LIST, async () => {
    return await detectShells();
  });

  ipcMain.handle(IPC.SETTINGS_GET_DEFAULT_SHELL, () => {
    return getDefaultShellId() || null;
  });

  ipcMain.handle(IPC.SETTINGS_SET_DEFAULT_SHELL, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return;
    if (!getCachedShells().some((s) => s.id === id)) return;
    setDefaultShellId(id);
  });

  ipcMain.handle(IPC.SETTINGS_OPEN_GLOBAL, async () => {
    const configPath = ensureGlobalConfig();
    const error = await shell.openPath(configPath);
    if (error) {
      dialog.showErrorBox('Failed to open global settings', error);
    }
  });

  ipcMain.handle(IPC.SETTINGS_OPEN_PROJECT, async (_event, { cwd }: { cwd: string }) => {
    if (typeof cwd !== 'string') return;
    const configPath = ensureProjectConfig(cwd);
    const error = await shell.openPath(configPath);
    if (error) {
      dialog.showErrorBox('Failed to open project settings', error);
    }
  });

  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_event, { path: reqPath }: { path: string }) => {
    if (typeof reqPath !== 'string') return;

    // Security: only allow opening directories that are known session cwds.
    // This prevents the renderer from opening arbitrary files/executables.
    const resolved = path.resolve(reqPath);
    const knownCwds = new Set(
      sessionManager.list().map((s) => path.resolve(s.cwd))
    );

    if (!knownCwds.has(resolved)) {
      console.warn('[openPath] Blocked — not a known session cwd:', resolved);
      throw new Error('Path is not a known session working directory');
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory');
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new Error('Path does not exist', { cause: err });
      throw err;
    }

    const error = await shell.openPath(resolved);
    if (error) {
      console.error('Failed to open path:', error);
      throw new Error(error);
    }
  });

  // ── Git operations ──────────────────────────────────────────

  ipcMain.handle(IPC.GIT_STATUS, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') return { isRepo: false, files: [], repoRoot: '' };
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) return { isRepo: false, files: [], repoRoot: '' };
    return getGitStatus(cwd);
  });

  ipcMain.handle(IPC.GIT_FILE_DIFF, async (_event, { sessionId, filePath, staged }: { sessionId: string; filePath: string; staged: boolean }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return getFileDiff(status.repoRoot, filePath, !!staged);
  });

  ipcMain.handle(IPC.GIT_SAVE_FILE, async (_event, { sessionId, filePath, content }: { sessionId: string; filePath: string; content: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string' || typeof content !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return saveFile(status.repoRoot, filePath, content);
  });

  ipcMain.handle(IPC.GIT_STAGE_FILE, async (_event, { sessionId, filePath }: { sessionId: string; filePath: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return stageFile(status.repoRoot, filePath);
  });

  ipcMain.handle(IPC.GIT_UNSTAGE_FILE, async (_event, { sessionId, filePath }: { sessionId: string; filePath: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return unstageFile(status.repoRoot, filePath);
  });

  ipcMain.handle(IPC.GIT_STAGE_ALL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return stageAll(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_UNSTAGE_ALL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return unstageAll(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_COMMIT, async (_event, { sessionId, message }: { sessionId: string; message: string }) => {
    if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim()) {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitCommit(status.repoRoot, message);
  });

  ipcMain.handle(IPC.GIT_PUSH, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitPush(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_PULL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitPull(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_LOG, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitLog(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_BRANCH_INFO, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') return null;
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) return null;
    const status = await getGitStatus(cwd);
    if (!status.isRepo) return null;
    return gitBranchInfo(status.repoRoot);
  });

  // ── Drawing canvas persistence ─────────────────────────────────────────────
  const canvasDir = path.join(app.getPath('home'), '.agentplex');
  const canvasPath = path.join(canvasDir, 'canvas.json');

  ipcMain.handle(IPC.CANVAS_LOAD, async (): Promise<DrawingData> => {
    try {
      const raw = fs.readFileSync(canvasPath, 'utf-8');
      return JSON.parse(raw) as DrawingData;
    } catch {
      return { elements: [], version: 1 };
    }
  });

  ipcMain.handle(IPC.CANVAS_SAVE, async (_event, data: DrawingData): Promise<void> => {
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(canvasPath, JSON.stringify(data), 'utf-8');
  });

  // ── Node grouping persistence ──────────────────────────────────────────────
  const groupsPath = path.join(canvasDir, 'groups.json');

  ipcMain.handle(IPC.GROUPS_LOAD, async (): Promise<PersistedGroups> => {
    try {
      const raw = fs.readFileSync(groupsPath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedGroups;
      if (parsed && Array.isArray(parsed.groups)) return parsed;
      return { groups: [] };
    } catch {
      return { groups: [] };
    }
  });

  ipcMain.handle(IPC.GROUPS_SAVE, async (_event, data: PersistedGroups): Promise<void> => {
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(groupsPath, JSON.stringify(data), 'utf-8');
  });

  // Return persisted state (state.json) so renderer can read UUIDs
  ipcMain.handle(IPC.SESSION_GET_PERSISTED, async () => {
    return sessionManager.loadState();
  });

  // ── Workspace templates ────────────────────────────────────────────────────
  const templatesPath = path.join(canvasDir, 'templates.json');

  ipcMain.handle(IPC.TEMPLATES_LOAD, async (): Promise<WorkspaceTemplate[]> => {
    try {
      return JSON.parse(fs.readFileSync(templatesPath, 'utf-8'));
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.TEMPLATES_SAVE, async (_event, templates: WorkspaceTemplate[]): Promise<void> => {
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf-8');
  });
}
