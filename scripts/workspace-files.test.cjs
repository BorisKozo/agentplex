const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadSource } = require('./test-support.cjs');
const { listWorkspaceDirectory, readWorkspaceFile } = loadSource('src/main/workspace-files.ts');
const { findArtifactReferences, terminalArtifactReferences } = loadSource('src/shared/artifact-links.ts');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'workspace'), outside = path.join(home, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'report data.json'), '{"message":"\u03bb"}');
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
  return { home, root, outside };
}

test('workspace tree is lazy, sorted, bounded and never follows escaping junctions', async t => {
  const { root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const result = await listWorkspaceDirectory(root);
  assert.equal(result.entries[0].name, 'nested');
  assert.equal(result.entries.find(entry => entry.name === 'escape').blocked, true);
  await assert.rejects(listWorkspaceDirectory(root, 'escape'), /outside/);
  await assert.rejects(readWorkspaceFile(root, path.join('escape', 'secret.json')), /outside/);
  await assert.rejects(listWorkspaceDirectory(root, '..'), /outside/);
  await assert.rejects(readWorkspaceFile(root, path.join(outside, 'secret.json')), /outside/);
  for (let index = 0; index < 501; index++) fs.writeFileSync(path.join(root, `entry-${index}.md`), '');
  const bounded = await listWorkspaceDirectory(root);
  assert.equal(bounded.entries.length, 500);
  assert.equal(bounded.truncated, true);
});

test('previews resolve file URLs, spaces and source locations; session artifacts are explicitly scoped', async t => {
  const { root, outside } = fixture(t);
  for (const reference of ['report data.json:12:3', pathToFileURL(path.join(root, 'report data.json')).href + '#L12']) {
    const result = await readWorkspaceFile(root, reference);
    assert.equal(result.content, '{"message":"\u03bb"}');
  }
  const artifact = await readWorkspaceFile(root, path.join(outside, 'secret.json'), outside);
  assert.equal(artifact.name, 'secret.json');
  assert.equal((await readWorkspaceFile(root, 'files/secret.json', outside)).name, 'secret.json');
  await assert.rejects(readWorkspaceFile(root, 'https://example.org/report.json'), /local file/);
  await assert.rejects(readWorkspaceFile(root, 'javascript:alert(1)'), /local file/);
  await assert.rejects(readWorkspaceFile(root, 'missing.md'), /ENOENT/);
});

test('previews reject unsupported, binary, invalid UTF-8, directory and oversized content explicitly', async t => {
  const { root } = fixture(t);
  for (const [name, data, expected] of [
    ['unsupported.exe', 'text', /Unsupported file type/],
    ['document.pdf', '%PDF-1.4', /Unsupported file type/],
    ['binary.md', Buffer.from([0, 1, 2]), /Binary/],
    ['invalid.md', Buffer.from([255]), /UTF-8/],
    ['huge.json', 'x'.repeat(1024 * 1024 + 1), /1 MiB/],
  ]) {
    fs.writeFileSync(path.join(root, name), data);
    await assert.rejects(readWorkspaceFile(root, name), expected);
  }
  fs.mkdirSync(path.join(root, 'directory.md'));
  await assert.rejects(readWorkspaceFile(root, 'directory.md'), /regular file/);
});

test('text, code, Markdown, HTML, CSV, JSON and Mermaid files are read as plain text, never interpreted', async t => {
  const { root } = fixture(t);
  const content = '<script>doNotExecute()</script>\n# Title\n"Last, First",=1+1\nflowchart LR\nA-->B';
  for (const name of ['notes.txt', 'debug.log', 'config.yaml', 'source.ts', 'data.xml', 'events.jsonl',
    'readme.md', 'page.html', 'data.csv', 'data.tsv', 'broken.json', 'diagram.mmd', 'diagram.mermaid']) {
    fs.writeFileSync(path.join(root, name), content);
    const file = await readWorkspaceFile(root, name);
    assert.deepEqual(Object.keys(file).sort(), ['content', 'name', 'path']);
    assert.equal(file.content, content, `${name} is returned byte for byte`);
    assert.equal(findArtifactReferences('Open `' + name + '`')[0]?.reference, name);
  }
  fs.writeFileSync(path.join(root, 'unicode.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('UTF16 λ', 'utf16le')]));
  assert.equal((await readWorkspaceFile(root, 'unicode.txt')).content, 'UTF16 λ');
});

test('terminal references include Markdown, quoted Windows paths, file URLs and source locations, but not web URLs or non-text files', () => {
  const text = '[report](reports/report data.md) `config.json:12:3` "C:\\My Files\\index.html" file:///C:/repo/data.json#L7 https://example.org/page.html [PDF](docs/my report.pdf) file:///C:/repo/report.TXT';
  const links = findArtifactReferences(text);
  assert.deepEqual(links.map(link => link.reference), [
    'reports/report data.md', 'config.json:12:3', 'C:\\My Files\\index.html', 'file:///C:/repo/data.json#L7',
    'file:///C:/repo/report.TXT',
  ]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.reference);
});

test('real xterm links span wrapped rows and retain correct cells after Unicode text', async t => {
  const { Terminal } = require('@xterm/xterm');
  const term = new Terminal({ cols: 24, rows: 8 });
  t.after(() => term.dispose());
  const reference = 'C:\\workspace folder\\generated\\report.json';
  await new Promise(resolve => term.write('\u4e2d\ud83d\ude80 `' + reference + '`', resolve));
  const links = terminalArtifactReferences(term.buffer.active, term.cols, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].reference, reference);
  assert.deepEqual(links[0].range.start, { x: 6, y: 1 });
  assert.ok(links[0].range.end.y > 1);
  const continuation = terminalArtifactReferences(term.buffer.active, term.cols, 2);
  assert.deepEqual(continuation, links);
});
