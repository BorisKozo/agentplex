const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

function session(id, cwd = 'C:\\work') {
  return { id, resumeSessionId: null, cli: 'claude', cwd, title: id, status: 'idle', startedAt: 123 };
}

// A fresh store with the given sessions, each card measured at 240x120.
function withStore(run) {
  const prior = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle };
  global.window = { agentPlex: { updateSessionState() {} } };
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: () => '#abcdef' });
  try {
    const store = loadSource('src/renderer/store.ts', {
      './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
    });
    const { useAppStore } = store;
    const addSessions = (...list) => {
      for (const info of list) useAppStore.getState().addSession(typeof info === 'string' ? session(info) : info);
      useAppStore.setState({ nodes: useAppStore.getState().nodes.map(node =>
        node.type === 'sessionNode' ? { ...node, measured: { width: 240, height: 120 } } : node) });
    };
    const node = id => useAppStore.getState().nodes.find(n => n.id === id);
    const group = () => useAppStore.getState().nodes.find(n => n.type === 'groupNode');
    return run({ store, useAppStore, addSessions, node, group });
  } finally { Object.assign(global, prior); }
}

const absolute = (nodes, id) => {
  const node = nodes.find(n => n.id === id);
  const parent = nodes.find(n => n.id === node.parentId);
  return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
};
const centerOf = group => ({ x: group.position.x + group.width / 2, y: group.position.y + group.width / 2 });

// GraphCanvas with React Flow and the hooks stubbed: returns the props it hands to
// <ReactFlow>, its effects, and the viewports it applied.
function renderCanvas(store) {
  const effects = [], applied = [];
  const jsx = (type, props) => ({ type, props });
  const real = store.useAppStore;
  const useAppStore = Object.assign(select => select(real.getState()), {
    getState: real.getState, setState: real.setState, subscribe: real.subscribe,
  });
  const canvas = loadSource('src/renderer/components/GraphCanvas.tsx', {
    react: { useCallback: fn => fn, useEffect: effect => effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@xyflow/react': {
      ReactFlow: 'ReactFlow', Background: 'Background', Controls: 'Controls', Panel: 'Panel',
      useReactFlow: () => ({ fitView() {}, setViewport: viewport => applied.push(viewport) }),
    },
    '@xyflow/react/dist/style.css': {},
    './SessionNode': { SessionNode: 'SessionNode' }, './GroupNode': { GroupNode: 'GroupNode' },
    './SubAgentNode': { SubAgentNode: 'SubAgentNode' }, './DrawingOverlay': { DrawingOverlay: 'DrawingOverlay' },
    '../store': { ...store, useAppStore },
  });
  const tree = canvas.GraphCanvas();
  const flow = [tree.props.children].flat().find(child => child?.type === 'ReactFlow');
  return { resolveDrop: canvas.resolveDrop, props: flow.props, effects, applied };
}

// One group holding `a`, with `b` and `c` ungrouped and far away from it.
function dropScene(t) {
  const { useAppStore, addSessions, node, group } = t;
  addSessions('a', 'b', 'c');
  useAppStore.getState().createGroupWithMembers(['a']);
  useAppStore.setState({ nodes: useAppStore.getState().nodes.map(n =>
    n.id === 'b' ? { ...n, position: { x: 5000, y: 5000 } }
      : n.id === 'c' ? { ...n, position: { x: -5000, y: -5000 } } : n) });
  const g = group();
  const center = centerOf(g);
  return {
    groupId: g.id,
    insideGroup: { ...node('c'), position: { x: center.x - 120, y: center.y - 60 } },
    onB: { ...node('c'), position: { x: 5010, y: 5010 } },
    nowhere: { ...node('c'), position: { x: -9000, y: 9000 } },
    memberOut: { ...node('a'), position: { x: g.width + 500, y: 0 } },
    memberIn: node('a'),
    groupNode: g,
  };
}

test('resolveDrop decides join, leave, stay and pair from where the card is released', () => {
  withStore(t => {
    const scene = dropScene(t);
    const { resolveDrop } = renderCanvas(t.store);
    assert.deepEqual(resolveDrop(scene.insideGroup), { kind: 'join', groupId: scene.groupId });
    assert.deepEqual(resolveDrop(scene.memberOut), { kind: 'leave', groupId: scene.groupId });
    assert.deepEqual(resolveDrop(scene.memberIn), { kind: 'stay', groupId: scene.groupId });
    assert.deepEqual(resolveDrop(scene.onB), { kind: 'pair', targetId: 'b' });
    assert.equal(resolveDrop(scene.nowhere), null);
    assert.equal(resolveDrop(scene.groupNode), null, 'dragging a whole group changes no membership');
  });
});

test('dragging shows a join or leave hint only, and dropping clears it and applies the change', () => {
  withStore(t => {
    const scene = dropScene(t);
    const { props } = renderCanvas(t.store);
    const hint = () => t.useAppStore.getState().groupDragHint;

    props.onNodeDrag(null, scene.insideGroup);
    assert.deepEqual(hint(), { groupId: scene.groupId, kind: 'join' });
    props.onNodeDrag(null, scene.memberOut);
    assert.deepEqual(hint(), { groupId: scene.groupId, kind: 'leave' });
    props.onNodeDrag(null, scene.memberIn);
    assert.equal(hint(), null, 'moving inside its own group is not a leave');
    props.onNodeDrag(null, scene.onB);
    assert.equal(hint(), null, 'pairing two cards has no group to outline');

    props.onNodeDrag(null, scene.insideGroup);
    props.onNodeDragStop(null, scene.insideGroup);
    assert.equal(hint(), null);
    assert.equal(t.node('c').parentId, scene.groupId, 'released inside the circle joins');

    props.onNodeDrag(null, scene.memberOut);
    props.onNodeDragStop(null, scene.memberOut);
    assert.equal(hint(), null);
    assert.equal(t.node('a').parentId, undefined, 'released outside the circle leaves');
  });
});

test('setGroupDragHint ignores repeats so drag moves do not re-render every group', () => {
  withStore(({ useAppStore }) => {
    const changes = [];
    const unsubscribe = useAppStore.subscribe(state => changes.push(state.groupDragHint));
    useAppStore.getState().setGroupDragHint({ groupId: 'g', kind: 'join' });
    useAppStore.getState().setGroupDragHint({ groupId: 'g', kind: 'join' });
    useAppStore.getState().setGroupDragHint({ groupId: 'g', kind: 'leave' });
    useAppStore.getState().setGroupDragHint(null);
    useAppStore.getState().setGroupDragHint(null);
    unsubscribe();
    assert.deepEqual(changes, [{ groupId: 'g', kind: 'join' }, { groupId: 'g', kind: 'leave' }, null]);
  });
});

test('the canvas turns off keyboard deletion, records pan/zoom and applies a restored viewport', () => {
  withStore(t => {
    const { props, effects, applied } = renderCanvas(t.store);
    assert.equal(props.deleteKeyCode, null, 'Backspace and Delete never remove nodes');
    props.onMoveEnd(null, { x: 12, y: -4, zoom: 1.25 });
    assert.deepEqual(t.useAppStore.getState().viewport, { x: 12, y: -4, zoom: 1.25 });
    effects.forEach(effect => effect());
    assert.deepEqual(applied, [], 'nothing applied without a restored viewport');

    t.useAppStore.setState({ restoredViewport: { x: 1, y: 2, zoom: 0.5 } });
    const again = renderCanvas(t.store);
    again.effects.forEach(effect => effect());
    assert.deepEqual(again.applied, [{ x: 1, y: 2, zoom: 0.5 }]);
    assert.equal(t.useAppStore.getState().restoredViewport, null, 'applied once, then cleared');
  });
});

test('groupSharedDirectory returns the directory every member shares, or null', () => {
  withStore(({ store }) => {
    const shared = (platform, ...cwds) => {
      const sessions = Object.fromEntries(cwds.map((cwd, i) => [`s${i}`, { ...session(`s${i}`), cwd }]));
      const nodes = [
        { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, data: {} },
        ...cwds.map((_, i) => ({ id: `s${i}`, type: 'sessionNode', parentId: 'g', position: { x: 0, y: 0 }, data: { sessionId: `s${i}` } })),
        { id: 'outside', type: 'sessionNode', position: { x: 0, y: 0 }, data: { sessionId: 'outside' } },
      ];
      sessions.outside = { ...session('outside'), cwd: 'D:\\elsewhere' };
      return store.groupSharedDirectory(nodes, sessions, 'g', platform);
    };
    assert.equal(shared('win32', 'C:\\work\\app', 'c:/Work/App/', 'C:\\WORK\\app\\'), 'C:\\work\\app',
      'Windows ignores case, slash direction and trailing separators, showing the first path');
    assert.equal(shared('win32', 'C:\\work\\app', 'C:\\work\\api'), null);
    assert.equal(shared('linux', '/home/me/app', '/home/me/app/'), '/home/me/app');
    assert.equal(shared('linux', '/home/me/app', '/home/me/App'), null, 'case matters off Windows');
    assert.equal(shared('linux', '/home/me/app', ''), null, 'an unknown directory is not shared');
    assert.equal(shared('linux', '/'), '/', 'the root directory survives trimming');
    assert.equal(shared('linux'), null, 'an empty group has no directory');
  });
});

test('setGroupColor recolors the group and the new color is saved with the layout', () => {
  withStore(({ store, useAppStore, addSessions, group }) => {
    addSessions('a', 'b');
    useAppStore.getState().createGroupWithMembers(['a', 'b']);
    useAppStore.getState().setGroupColor(group().id, '#123456');
    assert.equal(group().data.color, '#123456');
    const s = useAppStore.getState();
    assert.equal(store.serializeGroups(s.nodes, s.sessions, s.unresolvedGroups).groups[0].color, '#123456');
    assert.ok(store.GROUP_COLORS.length > 0 && store.GROUP_COLORS.every(c => /^#[0-9a-f]{6}$/i.test(c)));
  });
});

test('edge resize keeps the centre and every member in place and switches off auto-fit', () => {
  withStore(({ useAppStore, addSessions, group }) => {
    addSessions('a', 'b');
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map(n =>
      n.id === 'b' ? { ...n, position: { x: 600, y: 200 } } : n) });
    useAppStore.getState().createGroupWithMembers(['a', 'b']);
    const before = useAppStore.getState().nodes;
    const g = group();
    const resize = size => useAppStore.getState().resizeGroup(g.id, size, { recenter: true, keepMembersInPlace: true });

    resize(g.width + 250);
    let nodes = useAppStore.getState().nodes;
    assert.equal(group().width, g.width + 250);
    assert.equal(group().data.manualSize, g.width + 250);
    assert.deepEqual(centerOf(group()), centerOf(g));
    for (const id of ['a', 'b']) assert.deepEqual(absolute(nodes, id), absolute(before, id), `${id} stays put`);

    resize(10);
    assert.equal(group().width, 120, 'clamped to the minimum size');
    assert.deepEqual(centerOf(group()), centerOf(g));
    nodes = useAppStore.getState().nodes;
    for (const id of ['a', 'b']) assert.deepEqual(absolute(nodes, id), absolute(before, id));

    // Without keepMembersInPlace the members ride along with the group's corner.
    useAppStore.getState().resizeGroup(g.id, 900, { recenter: true });
    assert.notDeepEqual(absolute(useAppStore.getState().nodes, 'a'), absolute(before, 'a'));
  });
});

test('join and leave outline colors are theme tokens defined for both themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'index.css'), 'utf8');
  const block = selector => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (const theme of ['[data-theme="dark"]', '[data-theme="light"]']) {
    const join = block(theme).match(/--join-group:\s*(#[0-9a-f]{6})/i)?.[1];
    const leave = block(theme).match(/--leave-group:\s*(#[0-9a-f]{6})/i)?.[1];
    assert.ok(join && leave, `${theme} defines both tokens`);
    const [jr, , jb] = rgb(join), [lr, , lb] = rgb(leave);
    assert.ok(jb > jr, `${theme} join defaults to blue`);
    assert.ok(lr > lb, `${theme} leave defaults to red`);
  }
  assert.match(css, /\.graph-group\[data-drop="join"\],\s*\.graph-group\[data-drop="leave"\]\s*\{\s*--drop-color:\s*var\(--join-group\)/);
  assert.match(css, /\.graph-group\[data-drop="leave"\]\s*\{\s*--drop-color:\s*var\(--leave-group\)/);
  assert.match(css, /--color-join-group:\s*var\(--join-group\)/);
  assert.match(css, /--color-leave-group:\s*var\(--leave-group\)/);
});

test('groupSessionCli picks the CLI every member uses, counting resumes as new sessions, else Claude', () => {
  withStore(({ store }) => {
    const cli = (...clis) => {
      const sessions = Object.fromEntries(clis.map((c, i) => [`s${i}`, { ...session(`s${i}`), cli: c }]));
      const nodes = [
        { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, data: {} },
        ...clis.map((_, i) => ({ id: `s${i}`, type: 'sessionNode', parentId: 'g', position: { x: 0, y: 0 }, data: { sessionId: `s${i}` } })),
      ];
      return store.groupSessionCli(nodes, sessions, 'g');
    };
    assert.equal(cli('copilot', 'copilot-resume'), 'copilot');
    assert.equal(cli('claude-resume'), 'claude');
    assert.equal(cli('pwsh', 'pwsh'), 'pwsh', 'shell groups start another shell');
    assert.equal(cli('codex', 'claude'), 'claude', 'mixed groups fall back to Claude');
    assert.equal(cli(), 'claude');
  });
});

test('addToGroup can centre the joining card on a canvas point', () => {
  withStore(({ useAppStore, addSessions, node, group }) => {
    addSessions('a', 'b');
    useAppStore.getState().createGroupWithMembers(['a']);
    const g = group();
    const point = centerOf(g);
    useAppStore.getState().addToGroup(g.id, 'b', { center: point });
    const nodes = useAppStore.getState().nodes;
    assert.equal(node('b').parentId, g.id);
    assert.deepEqual(absolute(nodes, 'b'), { x: point.x - 120, y: point.y - 60 });
  });
});
