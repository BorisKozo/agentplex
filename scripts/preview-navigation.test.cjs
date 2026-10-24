const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

function install(currentUrl) {
  const handlers = {};
  let openHandler;
  const contents = {
    getURL: () => currentUrl,
    on: (name, handler) => { handlers[name] = handler; },
    setWindowOpenHandler: handler => { openHandler = handler; },
  };
  loadSource('src/main/preview-navigation.ts').installPreviewNavigation(contents);
  const prevented = (name, details) => {
    let blocked = false;
    handlers[name]({ ...details, preventDefault: () => { blocked = true; } });
    return blocked;
  };
  return { prevented, openHandler };
}

test('the app page may reload itself, which Vite dev reloads rely on', () => {
  const { prevented } = install('http://localhost:5173/');
  assert.equal(prevented('will-navigate', { url: 'http://localhost:5173/' }), false);
});

test('every other page-initiated navigation and new window is blocked', () => {
  const { prevented, openHandler } = install('http://localhost:5173/');
  assert.equal(prevented('will-navigate', { url: 'https://example.com/' }), true);
  assert.equal(prevented('will-navigate', { url: 'http://localhost:5173/other' }), true);
  assert.equal(prevented('will-navigate', { url: 'file:///C:/work/preview.html' }), true);
  assert.deepEqual(openHandler({ url: 'https://example.com/' }), { action: 'deny' });
});

test('preview frames may only load srcdoc or blank documents', () => {
  const { prevented } = install('http://localhost:5173/');
  assert.equal(prevented('will-frame-navigate', { isMainFrame: false, url: 'about:srcdoc' }), false);
  assert.equal(prevented('will-frame-navigate', { isMainFrame: false, url: 'about:blank' }), false);
  assert.equal(prevented('will-frame-navigate', { isMainFrame: false, url: 'https://example.com/' }), true);
  assert.equal(prevented('will-frame-navigate', { isMainFrame: true, url: 'https://example.com/' }), false,
    'main-frame navigations are decided by will-navigate');
});
