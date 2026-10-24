const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

// A store loaded against an in-memory localStorage holding `saved`.
function withStore(saved, run) {
  const items = new Map(Object.entries(saved));
  const localStorage = {
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
  try {
    const store = loadSource('src/renderer/store.ts', {
      './components/panels/SettingsPanel': { getSplitPaneEnabled: () => true },
    });
    return run({ store, items });
  } finally {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
    else delete globalThis.localStorage;
  }
}

// TerminalPanel's top-level tree with React and the pane's dependencies stubbed.
function renderPanel(store) {
  const jsx = (type, props) => ({ type, props });
  const real = store.useAppStore;
  const useAppStore = Object.assign(select => select(real.getState()), { getState: real.getState });
  const stub = new Proxy({}, { get: (_target, name) => name });
  const panel = loadSource('src/renderer/components/TerminalPanel.tsx', {
    react: { lazy: load => load, Suspense: 'Suspense', useRef() {}, useEffect() {}, useCallback: fn => fn, useState() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': stub,
    './CliIcon': stub, '../hooks/useTerminal': stub, '../monaco-theme': stub,
    '../../shared/ipc-channels': stub, './StatusIndicator': stub, './WorkspaceExplorer': stub, './SessionMetrics': stub,
    '../store': { ...store, useAppStore },
  });
  return panel.TerminalPanel();
}

test('the panel position defaults to the side and reads a saved choice', () => {
  withStore({}, ({ store }) => {
    assert.equal(store.useAppStore.getState().panelPosition, 'side');
  });
  withStore({ 'agentplex-panel-position': 'bottom' }, ({ store }) => {
    assert.equal(store.useAppStore.getState().panelPosition, 'bottom');
  });
  withStore({ 'agentplex-panel-position': 'sideways' }, ({ store }) => {
    assert.equal(store.useAppStore.getState().panelPosition, 'side', 'unknown values fall back to the side');
  });
});

test('setPanelPosition applies and saves the choice', () => {
  withStore({}, ({ store, items }) => {
    store.useAppStore.getState().setPanelPosition('bottom');
    assert.equal(store.useAppStore.getState().panelPosition, 'bottom');
    assert.equal(items.get('agentplex-panel-position'), 'bottom');
    store.useAppStore.getState().setPanelPosition('side');
    assert.equal(items.get('agentplex-panel-position'), 'side');
  });
});

test('at the bottom, session panes stack top to bottom', () => {
  withStore({}, ({ store }) => {
    store.useAppStore.setState({ openPanes: ['a', 'b'] });
    const side = renderPanel(store);
    assert.doesNotMatch(side.props.className, /flex-col/, 'side by side at the side');

    store.useAppStore.getState().setPanelPosition('bottom');
    const bottom = renderPanel(store);
    assert.match(bottom.props.className, /flex-col/);
    const panes = [bottom.props.children].flat();
    assert.equal(panes.length, 2);
    for (const pane of panes) assert.match(pane.props.className, /flex-col/);
  });
});
