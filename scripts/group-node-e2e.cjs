const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

// Renders the real GroupNode circle and checks its drop outline, shared-directory
// line, color picker and edge resize.
async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [repositoryRoot] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [repositoryRoot] }));
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const store = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const { useAppStore, GROUP_COLORS } = store;
  const { GroupNode } = loadSource('src/renderer/components/GroupNode.tsx', { '../store': store });

  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  window.agentPlex = { platform: 'win32' };
  // Synthetic pointer events have no active pointer to capture.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
  Element.prototype.releasePointerCapture = () => {};

  // Just the layout utilities the circle relies on (Tailwind isn't loaded here).
  const style = document.createElement('style');
  style.textContent = '.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}'
    + '.w-full{width:100%}.h-full{height:100%}';
  document.head.append(style);
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'absolute', left: '100px', top: '100px', width: '300px', height: '300px' });
  document.body.append(host);

  const session = (id, cwd) => ({ id, title: id, status: 'idle', cli: 'claude', cwd });
  const member = id => ({ id, type: 'sessionNode', parentId: 'g', position: { x: 40, y: 40 }, data: { sessionId: id } });
  const groupNode = () => useAppStore.getState().nodes.find(n => n.id === 'g');
  useAppStore.setState({
    sessions: { a: session('a', 'C:\\work\\app'), b: session('b', 'c:/Work/App/') },
    nodes: [
      { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, width: 300, height: 300, data: { label: 'Team', color: GROUP_COLORS[0] } },
      member('a'), member('b'),
    ],
  });

  const reactRoot = createRoot(host);
  const render = () => reactRoot.render(React.createElement(GroupNode, { id: 'g', data: groupNode().data }));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `${label} ${errors.join('\n')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const circle = () => host.querySelector('.graph-group');
  const picker = () => document.querySelector('[role="dialog"][aria-label="Group color"]');
  const fire = (target, type, init = {}) => {
    const Event = type.startsWith('pointer') ? PointerEvent : type.startsWith('key') ? KeyboardEvent : MouseEvent;
    target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init }));
  };
  const results = {};

  render();
  await wait(() => circle(), 'group renders');
  assert.equal(host.querySelector('.react-flow__resize-control'), null, 'no resize box');

  // Drop outline: follows the drag hint for this group only.
  assert.equal(circle().dataset.drop, undefined);
  useAppStore.getState().setGroupDragHint({ groupId: 'g', kind: 'join' });
  await wait(() => circle().dataset.drop === 'join', 'join outline');
  useAppStore.getState().setGroupDragHint({ groupId: 'g', kind: 'leave' });
  await wait(() => circle().dataset.drop === 'leave', 'leave outline');
  useAppStore.getState().setGroupDragHint({ groupId: 'other', kind: 'join' });
  await wait(() => circle().dataset.drop === undefined, 'no outline for another group');
  useAppStore.getState().setGroupDragHint(null);
  results.dropOutline = true;

  // Shared directory: shown under the name while every member works in it.
  const directory = () => host.querySelector('.graph-group__directory');
  await wait(() => directory(), 'shared directory shown');
  assert.equal(directory().textContent, 'C:\\work\\app');
  assert.equal(directory().title, 'C:\\work\\app');
  assert.equal(circle().dataset.sharedDirectory, 'true');
  useAppStore.setState({ sessions: { ...useAppStore.getState().sessions, b: session('b', 'C:\\work\\api') } });
  await wait(() => !directory(), 'hidden once members differ');
  assert.equal(circle().dataset.sharedDirectory, undefined);
  assert.equal(host.querySelector('.graph-group__label').textContent, 'Team');
  results.sharedDirectory = true;

  // Color picker: right-click the dot, pick a preset (closes) or a custom color (stays open).
  const swatch = host.querySelector('.graph-group__swatch');
  assert.match(swatch.title, /Right-click/);
  fire(swatch, 'contextmenu', { clientX: 120, clientY: 90 });
  await wait(() => picker(), 'picker opens');
  const presets = [...picker().querySelectorAll('.group-color-picker__swatch')];
  assert.equal(presets.length, GROUP_COLORS.length);
  assert.equal(presets[0].getAttribute('aria-pressed'), 'true', 'current color is marked');
  presets[3].click();
  await wait(() => !picker(), 'picking a preset closes the picker');
  assert.equal(groupNode().data.color, GROUP_COLORS[3]);
  render();

  fire(swatch, 'contextmenu', { clientX: 120, clientY: 90 });
  await wait(() => picker(), 'picker reopens');
  const custom = picker().querySelector('input[type="color"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(custom, '#00ff00');
  custom.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(() => groupNode().data.color === '#00ff00', 'custom color applies live');
  assert.ok(picker(), 'custom color keeps the picker open');
  fire(document, 'keydown', { key: 'Escape' });
  await wait(() => !picker(), 'Escape closes the picker');

  fire(swatch, 'contextmenu', { clientX: 120, clientY: 90 });
  await wait(() => picker(), 'picker reopens again');
  fire(document.body, 'pointerdown', { clientX: 5, clientY: 5 });
  await wait(() => !picker(), 'clicking outside closes the picker');
  results.colorPicker = true;

  // Edge resize: the cursor follows the angle; dragging sets the diameter from the centre (250, 250).
  const ring = host.querySelector('.graph-group__edge-ring');
  assert.ok(ring.closest('svg').classList.contains('nodrag'), 'React Flow does not drag the group from the edge');
  fire(ring, 'pointermove', { clientX: 400, clientY: 250 });
  assert.equal(ring.style.cursor, 'ew-resize');
  fire(ring, 'pointermove', { clientX: 250, clientY: 100 });
  assert.equal(ring.style.cursor, 'ns-resize');
  fire(ring, 'pointermove', { clientX: 356, clientY: 356 });
  assert.equal(ring.style.cursor, 'nwse-resize');
  assert.equal(groupNode().width, 300, 'hovering does not resize');

  fire(ring, 'pointerdown', { clientX: 400, clientY: 250 });
  await wait(() => circle().dataset.resizing === 'true', 'resizing state');
  fire(ring, 'pointermove', { clientX: 450, clientY: 250 });
  await wait(() => groupNode().width === 400, `diameter follows the pointer, got ${groupNode().width}`);
  assert.equal(groupNode().data.manualSize, 400, 'auto-fit is off after a manual resize');
  assert.deepEqual(groupNode().position, { x: -50, y: -50 }, 'centre stays put');
  const memberA = useAppStore.getState().nodes.find(n => n.id === 'a');
  assert.deepEqual(memberA.position, { x: 90, y: 90 }, 'members stay put on the canvas');
  fire(ring, 'pointerup', { clientX: 450, clientY: 250 });
  await wait(() => circle().dataset.resizing === undefined, 'resizing ends on release');
  fire(ring, 'pointermove', { clientX: 500, clientY: 250 });
  assert.equal(groupNode().width, 400, 'moving after release does not resize');
  results.edgeResize = true;

  // Double-click: starts a session in the shared directory, where the circle was clicked.
  const created = [];
  window.agentPlex.createSession = (cwd, cli) => {
    created.push([cwd, cli]);
    return Promise.resolve({ ...session(`new-${created.length}`, cwd), cli, pid: 1, startedAt: Date.now() });
  };
  assert.ok(!circle().classList.contains('nopan'), 'without a shared directory the canvas still zooms on double-click');
  fire(circle(), 'dblclick', { clientX: 300, clientY: 260 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(created, [], 'no shared directory, no session');

  useAppStore.setState({ sessions: { ...useAppStore.getState().sessions, b: { ...session('b', 'C:\\work\\app\\'), cli: 'claude-resume' } } });
  await wait(() => circle().classList.contains('nopan'), 'double-click zoom turned off for shared-directory groups');
  fire(host.querySelector('.graph-group__label'), 'dblclick', { clientX: 250, clientY: 90 });
  await wait(() => host.querySelector('.graph-group__label input'), 'the label still renames on double-click');
  fire(host.querySelector('.graph-group__label input'), 'keydown', { key: 'Escape' });
  assert.deepEqual(created, [], 'renaming does not start a session');

  fire(circle(), 'dblclick', { clientX: 300, clientY: 260 });
  fire(circle(), 'dblclick', { clientX: 300, clientY: 260 });
  await wait(() => useAppStore.getState().nodes.find(n => n.id === 'new-1')?.parentId === 'g', 'new session joins the group');
  assert.deepEqual(created, [['C:\\work\\app', 'claude']], 'one session, in the directory, with the members\' CLI');
  const group = groupNode(), card = useAppStore.getState().nodes.find(n => n.id === 'new-1');
  // (300, 260) is 200, 160 into the circle's box; the card is centred there.
  assert.deepEqual({ x: group.position.x + card.position.x, y: group.position.y + card.position.y },
    { x: -50 + 200 - 90, y: -50 + 160 - 28 });
  results.doubleClickStartsSession = true;

  reactRoot.unmount();
  return results;
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
