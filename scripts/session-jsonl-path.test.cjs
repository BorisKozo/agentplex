const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');

test('JSONL paths resolve Copilot source and Claude source histories without guessing other session identities', () => {
  const { SessionManager } = loadSource('src/main/session-manager.ts', { electron: {}, 'node-pty': {} });
  const manager = new SessionManager();
  for (const cli of ['copilot', 'copilot-resume']) {
    manager.sessions.set(cli, { cli, cwd: process.cwd(), resumeSessionId: 'exact-uuid' });
    assert.equal(manager.getJsonlPath(cli), path.join(os.homedir(), '.copilot', 'session-state', 'exact-uuid', 'events.jsonl'));
  }
  manager.sessions.set('claude', { cli: 'claude', cwd: process.cwd(), resumeSessionId: 'claude-uuid' });
  assert.ok(manager.getJsonlPath('claude').endsWith('claude-uuid.jsonl'));
  assert.equal(manager.getJsonlPath('unknown'), null);
});
