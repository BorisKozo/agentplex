const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

function session(id, resumeSessionId) {
  return { id, resumeSessionId, cli: 'claude', cwd: process.cwd(), title: id, status: 'idle', startedAt: 123 };
}

// A fresh store per call stands in for a fresh launch of the renderer.
function launch(run) {
  const prior = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle };
  global.window = { agentPlex: { updateSessionState() {} } };
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: () => '#abcdef' });
  try {
    const { useAppStore, serializeGroups } = loadSource('src/renderer/store.ts', {
      './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
    });
    const save = () => {
      const s = useAppStore.getState();
      return JSON.parse(JSON.stringify(serializeGroups(s.nodes, s.sessions, s.unresolvedGroups, s.viewport)));
    };
    const addSessions = (...list) => {
      for (const [id, uuid] of list) useAppStore.getState().addSession(session(id, uuid));
      useAppStore.setState({ nodes: useAppStore.getState().nodes.map(node =>
        node.type === 'sessionNode' ? { ...node, measured: { width: 240, height: 120 } } : node) });
    };
    return run(useAppStore, save, addSessions);
  } finally { Object.assign(global, prior); }
}

const absolute = (nodes, id) => {
  const node = nodes.find(n => n.id === id);
  const parent = nodes.find(n => n.id === node.parentId);
  return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
};
const groupCenter = nodes => {
  const group = nodes.find(n => n.type === 'groupNode');
  return { x: group.position.x + group.width / 2, y: group.position.y + group.width / 2 };
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('a manually sized group and its members stay put across repeated restarts', () => {
  let layout, expected;
  launch((store, save, addSessions) => {
    addSessions(['a', A], ['b', B]);
    store.setState({ nodes: store.getState().nodes.map(n =>
      n.id === 'a' ? { ...n, position: { x: 400, y: 300 } } : n.id === 'b' ? { ...n, position: { x: 700, y: 360 } } : n) });
    store.getState().createGroupWithMembers(['a', 'b']);
    const group = store.getState().nodes.find(n => n.type === 'groupNode');
    // Edge-resize well beyond the auto-fit size, keeping centre and members fixed.
    store.getState().resizeGroup(group.id, group.width + 300, { recenter: true, keepMembersInPlace: true });
    const nodes = store.getState().nodes;
    expected = { a: absolute(nodes, 'a'), b: absolute(nodes, 'b'), center: groupCenter(nodes) };
    layout = save();
  });

  for (let restart = 1; restart <= 3; restart++) {
    launch((store, save, addSessions) => {
      // Fresh launch: new node ids, cards start on the default grid.
      addSessions(['s1', A], ['s2', B]);
      store.getState().restoreGroups(layout);
      const nodes = store.getState().nodes;
      assert.deepEqual(absolute(nodes, 's1'), expected.a, `member a after restart ${restart}`);
      assert.deepEqual(absolute(nodes, 's2'), expected.b, `member b after restart ${restart}`);
      assert.deepEqual(groupCenter(nodes), expected.center, `group centre after restart ${restart}`);
      layout = save();
    });
  }
});

test('ungrouped card positions and the viewport are saved and restored', () => {
  let layout;
  launch((store, save, addSessions) => {
    addSessions(['a', A], ['b', B], ['c', C]);
    store.setState({ nodes: store.getState().nodes.map(n =>
      n.id === 'c' ? { ...n, position: { x: -150, y: 820 } } : n) });
    store.getState().createGroupWithMembers(['a', 'b']);
    store.getState().setViewport({ x: 35, y: -80, zoom: 0.75 });
    layout = save();
    assert.equal(layout.sessions.length, 1, 'only the ungrouped card is listed outside groups');
    assert.deepEqual(layout.viewport, { x: 35, y: -80, zoom: 0.75 });
  });

  launch((store, _save, addSessions) => {
    addSessions(['s1', A], ['s2', B], ['s3', C]);
    store.getState().restoreGroups(layout);
    const state = store.getState();
    assert.deepEqual(absolute(state.nodes, 's3'), { x: -150, y: 820 });
    assert.equal(state.nodes.find(n => n.id === 's3').parentId, undefined, 'stays ungrouped');
    assert.deepEqual(state.viewport, { x: 35, y: -80, zoom: 0.75 });
    assert.deepEqual(state.restoredViewport, { x: 35, y: -80, zoom: 0.75 }, 'handed to the canvas');
  });
});

test('layouts saved before positions and viewport were recorded still restore', () => {
  launch((store, _save, addSessions) => {
    addSessions(['s1', A]);
    const before = store.getState().nodes.find(n => n.id === 's1').position;
    store.getState().restoreGroups({ groups: [] });
    const state = store.getState();
    assert.deepEqual(state.nodes.find(n => n.id === 's1').position, before);
    assert.equal(state.viewport, null);
    assert.equal(state.restoredViewport, null);
  });
});
