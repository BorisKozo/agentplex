const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [repositoryRoot] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [repositoryRoot] }));
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const { useAppStore, isSendTarget } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const writes = [];
  window.agentPlex = { platform: 'win32', writeSession: (id, data) => writes.push({ id, data }) };
  const source = { id: 'source', title: 'Source', status: 'idle', cli: 'copilot' };
  const target = { id: 'target', title: 'Target', status: 'idle', cli: 'claude' };
  const open = cli => useAppStore.setState({
    sendDialogSourceId: 'source', sessions: { source: { ...source, cli }, target },
    sessionBuffers: { source: 'RAW_PREVIEW' },
  });
  const { SendDialog } = loadSource('src/renderer/components/SendDialog.tsx', {
    '../store': { useAppStore, isSendTarget },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  function Harness() {
    return useAppStore(state => state.sendDialogSourceId) ? React.createElement(SendDialog) : null;
  }
  reactRoot.render(React.createElement(Harness));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const instruction = async () => {
    await wait(() => host.querySelector('textarea'), 'dialog mounts');
    const textarea = host.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Continue synthetic task');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => [...host.querySelectorAll('button')].some(button =>
      button.textContent.includes('Send') && !button.disabled), 'send enabled');
  };
  const send = () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Send'));
  const pastes = () => writes.filter(write => write.data.startsWith('\x1b[200~'));
  for (const cli of ['copilot', 'claude']) {
    open(cli);
    await instruction();
    assert.ok(!host.textContent.includes('Summarize'), 'there is no summary option');
    assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 2, 'only Select All and the one target');
    send().click();
    await wait(() => !host.querySelector('textarea'), 'dialog closes after send');
  }
  assert.equal(pastes().length, 2, 'one paste per send');
  for (const paste of pastes()) {
    assert.equal(paste.id, 'target');
    assert.match(paste.data, /Continue synthetic task/);
    assert.match(paste.data, /<session_context>\nContext from Source, another session instance of you:\nRAW_PREVIEW\n<\/session_context>/);
  }
  reactRoot.unmount();
  return { realReact: true, noSummaryOption: true, terminalContextSent: true };
}

let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('about:blank');
  const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))})`);
  console.log(JSON.stringify(result));
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
