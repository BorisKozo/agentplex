const { app, BrowserWindow, ipcMain, session, clipboard, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const repository = path.resolve(__dirname, '..');
const rendererRoot = process.env.AGENTPLEX_ARTIFACT_RENDERER_ROOT || repository;
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(workspace, 'nested'));
fs.writeFileSync(path.join(workspace, 'result.json'), '{"verified":"first"}');
fs.writeFileSync(path.join(workspace, 'data.csv'), 'Name,Notes,Formula\n"Last, First","line 1\nline 2",=1+1');
fs.writeFileSync(path.join(workspace, 'data.tsv'), 'A\tB\n1\t2');
fs.writeFileSync(path.join(workspace, 'report.pdf'), '%PDF-1.7\nnot a text file');
fs.writeFileSync(path.join(workspace, 'notes.txt'), '<script>window.textExecuted=true</script>\nPlain text λ');
fs.writeFileSync(path.join(workspace, 'settings.yaml'), 'enabled: true\nmode: native');
fs.writeFileSync(path.join(workspace, 'nested', 'next.json'), '{"nested":true}');
fs.writeFileSync(path.join(workspace, 'summary.md'), '# Native Markdown\n\n| Metric | Value |\n| --- | --- |\n| Tests | Passed |\n\n[Nested JSON](nested/next.json)\n\n<script>window.badMarkdown=true</script>\n<img src="https://preview-test.invalid/image">\n[Unsafe](javascript:alert(1))');
fs.writeFileSync(path.join(workspace, 'report.html'), '<h1 id="report">Native HTML</h1><script>window.badHtml=true</script>'
  + '<img src="https://preview-test.invalid/image"><a href="https://preview-test.invalid/navigation">Navigate</a>'
  + '<a href="https://preview-test.invalid/popup" target="_blank">Popup</a><form action="https://preview-test.invalid/form"><button>Send</button></form>');
const stateRoot = path.join(root, '.copilot', 'session-state');
fs.mkdirSync(stateRoot, { recursive: true });
const uuid = '12345678-1234-4234-8234-123456789012';
const events = path.join(stateRoot, uuid, 'events.jsonl');
const record = (type, data, timestamp = new Date().toISOString()) => JSON.stringify({ type, timestamp, data }) + '\n';
let manager, win;
const network = [], rendererErrors = [];
const wait = async (predicate, label) => {
  const end = Date.now() + 20000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
const evaluate = expression => win.webContents.executeJavaScript(expression);
const clickText = async (text, scope = 'document') => {
  await evaluate(`(() => {
    const button = [...${scope}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    button.click();
  })()`);
};
const preview = `[...document.querySelectorAll('section[aria-label="File preview"]')].find(element => element.getBoundingClientRect().width > 0)`;
async function setTheme(theme) {
  await evaluate(`document.querySelector('button[title="Settings"]').click()`);
  await wait(() => evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes('Switch to'))`), 'appearance settings');
  if (await evaluate(`document.documentElement.dataset.theme`) !== theme) {
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Switch to')).click()`);
  }
  await wait(() => evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme} theme applied`);
  await wait(() => win.getBackgroundColor().toLowerCase().endsWith(theme === 'dark' ? '181c20' : 'f3f1ec'), 'native window matches renderer theme');
  await evaluate(`document.querySelector('button[title="Settings"]').click()`);
}

async function assertThemedSurfaces(theme) {
  const result = await evaluate(`(() => {
    const color = selector => {
      let element = document.querySelector(selector);
      const text = getComputedStyle(element).color;
      while (getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)') element = element.parentElement;
      return { background: getComputedStyle(element).backgroundColor, text };
    };
    const card = document.querySelector('.session-node');
    const icon = card.querySelector('.cli-icon--' + ${JSON.stringify(theme)});
    const other = card.querySelector('.cli-icon--' + ${JSON.stringify(theme === 'dark' ? 'light' : 'dark')});
    return { surfaces: ['.app-toolbar', '.session-node', '.workspace-explorer',
      '.session-node .text-fg-muted', '.workspace-explorer > .text-fg-muted', '.app-toolbar button.bg-accent'].map(color),
      cardBorder: getComputedStyle(card).borderTopWidth,
      cardRadius: getComputedStyle(card).borderTopLeftRadius,
      iconVisible: getComputedStyle(icon).display !== 'none',
      otherIconHidden: getComputedStyle(other).display === 'none' };
  })()`);
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).reduce((sum, value, i) => {
    const channel = value / 255;
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
  for (const surface of result.surfaces) {
    const values = [luminance(surface.background), luminance(surface.text)].sort((a, b) => a - b);
    assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, `readable ${theme} UI: ${JSON.stringify(surface)}`);
  }
  assert.equal(result.surfaces[1].background, theme === 'dark' ? 'rgb(32, 37, 43)' : 'rgb(251, 250, 247)');
  assert.equal(result.cardBorder, '1px');
  assert.equal(result.cardRadius, theme === 'dark' ? '9px' : '13px');
  assert.equal(result.iconVisible && result.otherIconHidden, true, 'existing CLI icons switch without remounting');
}

async function clickTerminalText(text, attempt = 0) {
  await evaluate(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
  const point = await evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector('.xterm-rows'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.replace(/\\u00a0/g, ' ').indexOf(${JSON.stringify(text)});
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + 1); range.setEnd(node, index + 2);
      const rect = range.getBoundingClientRect();
      const row = node.parentElement.closest('.xterm-rows > div').getBoundingClientRect();
      if (rect.width && row.height) return {x: Math.floor(rect.x + rect.width / 2), y: Math.floor(row.y + row.height / 2)};
    }
    throw new Error('Terminal link not visible: ' + ${JSON.stringify(text)});
  })()`);
  const dispatch = type => evaluate(`(() => {
    const target = document.elementFromPoint(${point.x}, ${point.y});
    if (!target?.closest('.xterm')) throw new Error('Terminal link hit test failed: ' + target?.outerHTML);
    target.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, clientX: ${point.x}, clientY: ${point.y}, button: 0 }));
  })()`);
  await evaluate(`document.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${point.x + 80}, clientY: ${point.y + 20} }))`);
  await dispatch('mousemove');
  await new Promise(resolve => setTimeout(resolve, 250));
  const hover = await evaluate(`(() => {
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { pointer: !!document.querySelector('.xterm-cursor-pointer'), point: ${JSON.stringify(point)},
      screen: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      target: document.elementFromPoint(${point.x}, ${point.y})?.className,
      rows: [...document.querySelectorAll('.xterm-rows > div')].map((element, index) => ({
        index, text: element.textContent, top: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height
      })).filter(row => row.text).slice(0, 20) };
  })()`);
  if (!hover.pointer && attempt < 3) return clickTerminalText(text, attempt + 1);
  assert.equal(hover.pointer, true, JSON.stringify(hover));
  await dispatch('mousedown');
  await dispatch('mouseup');
}

app.whenReady().then(async () => {
  const overrides = {
    os: { ...os, homedir: () => root },
    'node-pty': { spawn() { assert.fail('A discovered CLI must not spawn another process'); } },
  };
  const { SessionManager } = loadSource('src/main/session-manager.ts', overrides);
  manager = new SessionManager();
  loadSource('src/main/ipc-handlers.ts', {
    ...overrides, './session-manager': { sessionManager: manager },
  }).registerIpcHandlers();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('https://preview-test.invalid')) network.push(details.url);
    callback({});
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:",
    ] },
  }));
  manager.start();
  await wait(() => !manager.discovery.baseline, 'historical baseline');
  win = new BrowserWindow({ show: false, width: 1400, height: 1000,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { height: 48, color: '#181c20', symbolColor: '#e4e8ed' } } : {}),
    webPreferences: { preload: path.join(repository, '.vite', 'build', 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  loadSource('src/main/preview-navigation.ts').installPreviewNavigation(win.webContents);
  win.webContents.on('console-message', event => {
    if (/Uncaught|Minified React error|Setting up fake worker|Failed to load font|Unable to load (?:font|CMap)/.test(event.message)) rendererErrors.push(event.message);
  });
  manager.setWindow(win);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }] }]));
  await win.loadFile(path.join(rendererRoot, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('.react-flow')`), 'full production renderer');
  const clipboardBefore = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  try {
    await evaluate(`window.agentPlex.clipboardWriteText('AGENTPLEX_CLIPBOARD_PROBE')`);
    assert.equal(clipboard.readText(), 'AGENTPLEX_CLIPBOARD_PROBE', 'sandboxed preload must write the native clipboard');
    assert.equal(await evaluate(`window.agentPlex.clipboardReadText()`), 'AGENTPLEX_CLIPBOARD_PROBE');
  } finally {
    clipboard.clear();
    for (const [format, bytes] of clipboardBefore) clipboard.writeBuffer(format, bytes);
  }
  await setTheme('light');
  await win.loadFile(path.join(rendererRoot, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('.react-flow')`), 'renderer reload');
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light', 'Stone persists across reload');
  // Align the fallback timer so it cannot satisfy the filesystem latency check.
  manager.discovery.stop();
  manager.discovery.start();
  await wait(() => !manager.discovery.busy, 'discovery watch ready');
  const discoveryBegan = performance.now();
  fs.mkdirSync(path.dirname(events));
  fs.writeFileSync(events, record('session.start', { context: { cwd: workspace } })
    + record('session.shutdown', {}, new Date(Date.now() - 60000).toISOString()));
  await wait(() => manager.list().length === 1, 'new CLI discovery');
  const info = manager.list()[0];
  assert.equal(info.readOnly, true);
  assert.equal(info.status, 'idle', 'copied parent shutdown must not kill the fork before it resumes');
  await wait(() => evaluate(`!!document.querySelector('[data-id="${info.id}"]')`), 'normal graph node');
  const discoveryMs = Math.round(performance.now() - discoveryBegan);
  assert.ok(discoveryMs < 750, `live graph discovery took ${discoveryMs}ms`);
  fs.appendFileSync(events, record('session.resume', { context: { cwd: workspace } })
    + record('assistant.turn_start', { turnId: 'child-working' })
    + record('assistant.message', { content: 'Open `result.json` for the generated output.\nRead `notes.txt` for the notes.' }));
  await wait(() => manager.list()[0]?.status === 'running', 'fork becomes active on the same monitor');
  await wait(() => evaluate(`[...document.querySelectorAll('[data-id="${info.id}"] span')].some(element => element.style.backgroundColor === 'var(--success)')`), 'running status rendered');
  fs.appendFileSync(events, JSON.stringify({ type: 'session.shutdown', timestamp: new Date().toISOString(),
    agentId: 'completed-sub-agent', data: {} }) + '\n');
  await wait(() => manager.sessions.get(info.id).jsonlWatcher.snapshotOffset === fs.statSync(events).size, 'attributed shutdown consumed');
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].status, 'running', 'a sub-agent shutdown must not kill its parent');
  await evaluate(`document.querySelector('[data-id="${info.id}"] > div').click()`);
  await wait(() => evaluate(`!!document.querySelector('.xterm-rows') && document.querySelector('aside[aria-label="Workspace files"]')?.textContent.includes('result.json')`), 'terminal and workspace tree');
  await evaluate(`window.testTerminalElement = document.querySelector('.xterm')`);
  await assertThemedSurfaces('light');
  await setTheme('dark');
  await assertThemedSurfaces('dark');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true, 'switching themes preserves the terminal instance');
  await evaluate(`document.querySelector('.session-node button[title="Rename session"]').focus()`);
  await wait(() => evaluate(`getComputedStyle(document.querySelector('.session-node__actions')).opacity === '1'`), 'node actions are visible on keyboard focus');
  const oldViewport = await evaluate(`document.querySelector('.react-flow__viewport').style.transform`);
  await evaluate(`document.querySelector('.react-flow__controls-zoomin').click()`);
  await wait(() => evaluate(`document.querySelector('.react-flow__viewport').style.transform`) !== oldViewport, 'graph dock zooms the real canvas');
  await setTheme('light');
  assert.equal(await evaluate(`document.querySelector('.xterm-helper-textarea').readOnly`), true);
  const selectedText = await evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector('.xterm-rows'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim().length < 8) continue;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 8);
      const rect = range.getBoundingClientRect();
      return { text: node.textContent.slice(0, 8).replace(/\\u00a0/g, ' '),
        x: Math.ceil(rect.left + 1), endX: Math.floor(rect.right + 1), y: Math.floor(rect.top + rect.height / 2) };
    }
    throw new Error('No terminal text available to copy');
  })()`);
  const savedClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  try {
    for (const modifiers of [['control'], ['control', 'shift'], null]) {
      clipboard.writeText('AGENTPLEX_COPY_NOT_YET');
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: selectedText.x, y: selectedText.y });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: selectedText.endX, y: selectedText.y, modifiers: ['leftButtonDown'] });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: selectedText.endX, y: selectedText.y });
      if (modifiers) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers });
      } else {
        const point = { x: Math.round((selectedText.x + selectedText.endX) / 2), y: selectedText.y };
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      }
      await wait(() => clipboard.readText() === selectedText.text, 'native keyboard copies mouse-selected terminal text with the application Edit menu');
    }
  } finally {
    clipboard.clear();
    for (const [format, bytes] of savedClipboard) clipboard.writeBuffer(format, bytes);
  }
  win.setContentSize(900, 1000);
  await wait(() => evaluate(`getComputedStyle(document.querySelector('aside[aria-label="Workspace files"]')).display === 'none'`), 'narrow panes preserve terminal space');
  win.setContentSize(1400, 1000);
  await wait(() => evaluate(`document.querySelector('aside[aria-label="Workspace files"]').getBoundingClientRect().width > 0`), 'workspace returns in a wide pane');
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('result.json')`), 'transcript file link');
  await clickTerminalText('result.json');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"verified":"first"')`), 'plain terminal path opens the text view');
  await setTheme('dark');
  assert.equal(await evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"verified":"first"')`), true, 'theme changes preserve the active artifact');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true);
  await clickText(info.title);
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('notes.txt')`), 'second terminal link');
  await clickTerminalText('notes.txt');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('Plain text λ')`), 'terminal link opens plain text');
  const openTree = async name => clickText(name, `document.querySelector('aside[aria-label="Workspace files"]')`);
  await openTree('summary.md');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('# Native Markdown')`), 'Markdown shown as source text');
  assert.equal(await evaluate(`(${preview}).querySelector('article, table, iframe, script, img') === null`), true, 'Markdown is not rendered');
  await openTree('report.html');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('<script>window.badHtml=true</script>')`), 'HTML shown as source text');
  assert.equal(await evaluate(`(${preview}).querySelector('iframe') === null && typeof window.badHtml`), 'undefined', 'HTML is never executed');
  await openTree('report.pdf');
  await wait(() => evaluate(`(${preview})?.querySelector('[role="alert"]')?.textContent.includes('Unsupported file type')`), 'non-text files show an explicit error');
  // In-process CDP emulates the reduced-motion preference without opening a TCP listener.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches
    && getComputedStyle(document.querySelector('.session-node')).transitionDuration.split(',').every(value => parseFloat(value) <= .01)`),
  true, 'system reduced-motion preference disables decorative transitions');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  win.webContents.debugger.detach();
  await openTree('data.csv');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"Last, First","line 1\\nline 2",=1+1')`), 'CSV shown as source text');
  await openTree('data.tsv');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('A\\tB')`), 'TSV shown as source text');
  await openTree('notes.txt');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('Plain text λ')`), 'native text');
  assert.equal(await evaluate(`typeof window.textExecuted`), 'undefined');
  await openTree('settings.yaml');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('mode: native')`), 'native YAML source');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true, 'opening files preserves the original terminal');
  assert.deepEqual(network, [], 'file views cannot load external resources');
  await clickText(info.title);
  fs.appendFileSync(events, record('assistant.message', { content: '\x1b]8;;' + require('node:url').pathToFileURL(path.join(workspace, 'result.json')).href + '\x07Open OSC artifact\x1b]8;;\x07' }));
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.replace(/\\u00a0/g, ' ').includes('Open OSC artifact')`), 'live transcript reaches same terminal');
  await clickTerminalText('Open OSC artifact');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"verified":"first"')`), 'OSC8 file link opens the text view');
  fs.writeFileSync(path.join(workspace, 'result.json'), '{"verified":"reloaded"}');
  await clickText('Reload', `(${preview})`);
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('reloaded')`), 'file reload');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true);
  const mounted = path.join(root, 'mounted');
  fs.mkdirSync(mounted);
  fs.writeFileSync(path.join(mounted, 'mounted.md'), '# Mounted workspace');
  fs.appendFileSync(events, record('session.resume', { context: { cwd: mounted } }));
  await wait(() => evaluate(`document.querySelector('aside[aria-label="Workspace files"]')?.textContent.includes('mounted.md')`), 'provider workspace changes refresh directory');
  await clickText('mounted.md', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent === '# Mounted workspace'`), 'mounted file preview');
  const clipboardProbe = { ...manager.sessions.get(info.id), id: 'clipboard-output-probe',
    title: 'Clipboard output probe', readOnly: false, jsonlWatcher: null, resumeSessionId: undefined,
    buffer: 'CLI clipboard output test\r\n', outputOffset: 0 };
  clipboardProbe.outputOffset = clipboardProbe.buffer.length;
  fs.appendFileSync(events, record('session.shutdown', {}));
  await wait(() => manager.list().length === 0, 'terminated discovered CLI removed from the main process');
  await wait(() => evaluate(`!document.querySelector('[data-id="${info.id}"]') && !document.body.innerText.includes(${JSON.stringify(info.title)})`),
    'terminated discovered CLI removed from graph, explorer and open terminal');
  fs.appendFileSync(events, record('assistant.message', { content: 'External CLI continues independently.' }));
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(manager.list().length, 0, 'stopped monitors must not immediately reattach');
  manager.sessions.set(clipboardProbe.id, clipboardProbe);
  manager.send(IPC.SESSION_CREATED, manager.list()[0]);
  manager.send(IPC.SESSION_DATA, { id: clipboardProbe.id, data: clipboardProbe.buffer, offset: clipboardProbe.outputOffset });
  await wait(() => evaluate(`!!document.querySelector('[data-id="${clipboardProbe.id}"]')`), 'test-owned writable session');
  await evaluate(`document.querySelector('[data-id="${clipboardProbe.id}"] > div').click()`);
  await wait(() => evaluate(`!!document.querySelector('.xterm-rows')?.textContent.includes('CLI clipboard output test')`), 'test-owned writable terminal');
  const beforeCliCopy = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  try {
    clipboard.writeText('NOT_YET_COPIED_BY_CLI');
    const expected = 'Copilot native copy: Ελληνικά 😀';
    const sequence = '\x1b]52;c;' + Buffer.from(expected).toString('base64') + '\x07';
    for (const data of [sequence.slice(0, 12), sequence.slice(12)]) {
      manager.appendOutput(clipboardProbe, data);
      manager.send(IPC.SESSION_DATA, { id: clipboardProbe.id, data, offset: clipboardProbe.outputOffset });
    }
    await wait(() => clipboard.readText() === expected, 'CLI output writes the OS clipboard through the real sandboxed renderer and preload');
  } finally {
    clipboard.clear();
    for (const [format, bytes] of beforeCliCopy) clipboard.writeBuffer(format, bytes);
    manager.sessions.delete(clipboardProbe.id);
    manager.send(IPC.SESSION_REMOVED, { id: clipboardProbe.id });
  }
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ normalCliDiscovery: true, discoveryMs, liveForkPreserved: true, attributedShutdownSafe: true,
    plainAndOsc8Links: true, sourceTextNeverRendered: true, unsupportedFilesVisible: true,
    blockedNetwork: true, workspaceMounts: true, terminalPreserved: true, externalProcessOwnership: true,
    plainAndCodeText: true, terminatedDiscoveryRemoved: true,
    sandboxClipboard: true, mouseSelectedTerminalCopy: true, cliOutputNativeClipboard: true,
    graphiteAndStone: true, persistedTheme: true, readableSurfaces: true, liveCliIcons: true, keyboardNodeActions: true, graphZoomDock: true,
    reducedMotion: true }));
  manager.stop();
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript('document.body.innerText.slice(-5000)').then(text => {
      console.error('Renderer state:', text);
      manager?.stop();
      win.destroy();
      app.exit(1);
    }).catch(() => app.exit(1));
    return;
  }
  manager?.stop();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
