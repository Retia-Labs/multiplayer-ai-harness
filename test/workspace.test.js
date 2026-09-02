/**
 * Tests for the workspace file layer.
 *
 * safeResolve is the editor's security boundary - every path it sees came from
 * somewhere a person can type - so the escape cases get the most attention
 * here. The stale-write case matters nearly as much: the agent is editing the
 * same tree at the same time as the person is.
 *
 * Run with: npm run test:workspace
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = require('../src/main/workspace');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ws-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  return dir;
}

/* ---------------- path containment ---------------- */

test('safeResolve accepts paths inside the workspace', () => {
  const root = tmpRoot();
  assert.equal(ws.safeResolve(root, 'src/index.js'), path.join(root, 'src', 'index.js'));
  assert.equal(ws.safeResolve(root, './README.md'), path.join(root, 'README.md'));
  assert.equal(ws.safeResolve(root, 'src/../README.md'), path.join(root, 'README.md'));
});

test('safeResolve refuses to escape the workspace', () => {
  const root = tmpRoot();
  for (const bad of [
    '../outside.txt',
    '../../etc/passwd',
    'src/../../escape.js',
    path.join(os.tmpdir(), 'absolute.txt')
  ]) {
    assert.throws(() => ws.safeResolve(root, bad), /escapes the workspace/, 'must refuse ' + bad);
  }
});

test('safeResolve refuses empty and NUL-bearing paths', () => {
  const root = tmpRoot();
  assert.throws(() => ws.safeResolve(root, ''), /Path required/);
  assert.throws(() => ws.safeResolve(root, 'a\0b'), /Invalid path/);
});

test('a sibling directory with the same prefix is still outside', () => {
  // /tmp/x-evil must not pass a startsWith check against /tmp/x.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prefix-'));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(base, 'proj-evil'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  assert.throws(() => ws.safeResolve(root, '../proj-evil/secret.txt'), /escapes the workspace/);
});

/* ---------------- tree ---------------- */

test('tree lists directories before files and skips noise', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'x');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');

  const list = ws.tree(root);
  const paths = list.map((e) => e.path);

  assert.ok(paths.includes('src'), 'directories are listed');
  assert.ok(paths.includes('src/index.js'));
  assert.ok(!paths.some((p) => p.startsWith('node_modules')), 'node_modules is skipped');
  assert.ok(!paths.some((p) => p.startsWith('.git')), '.git is skipped');
  assert.equal(list.find((e) => e.path === 'src').dir, true);
  assert.equal(list.find((e) => e.path === 'src/index.js').text, true);
});

test('tree marks unopenable files as not text', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const list = ws.tree(root);
  assert.equal(list.find((e) => e.path === 'logo.png').text, false);
});

test('tree honours its limit so a huge repo cannot hang the window', () => {
  const root = tmpRoot();
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(root, 'f' + i + '.txt'), 'x');
  assert.ok(ws.tree(root, { limit: 10 }).length <= 10);
});

/* ---------------- read ---------------- */

test('readFile returns content and a hash of it', () => {
  const root = tmpRoot();
  const f = ws.readFile(root, 'src/index.js');
  assert.equal(f.content, 'console.log(1);\n');
  assert.equal(f.hash, ws.contentHash('console.log(1);\n'));
});

test('readFile flags binary rather than handing back a mess', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]));
  const f = ws.readFile(root, 'blob.dat');
  assert.equal(f.binary, true);
  assert.equal(f.content, '');
});

test('readFile refuses to read outside the workspace', () => {
  const root = tmpRoot();
  assert.throws(() => ws.readFile(root, '../../secrets.txt'), /escapes the workspace/);
});

/* ---------------- write ---------------- */

test('writeFile creates and reports it created', () => {
  const root = tmpRoot();
  const r = ws.writeFile(root, 'src/new.js', 'const a = 1;\n');
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'new.js'), 'utf8'), 'const a = 1;\n');
});

test('writeFile makes missing directories', () => {
  const root = tmpRoot();
  ws.writeFile(root, 'a/b/c/deep.js', 'x');
  assert.equal(fs.readFileSync(path.join(root, 'a', 'b', 'c', 'deep.js'), 'utf8'), 'x');
});

test('writeFile refuses a stale write instead of clobbering the agent', () => {
  const root = tmpRoot();
  const before = ws.readFile(root, 'src/index.js');

  // The agent edits the same file while the person has it open.
  //
  // Deliberately asserts nothing about mtime: this write can land in the same
  // filesystem clock tick as the read above, which is exactly the conflict an
  // mtime comparison cannot see, and why the check is content-based.
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'console.log("agent was here");\n');

  const r = ws.writeFile(root, 'src/index.js', 'console.log("person");\n', {
    expectedHash: before.hash
  });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8'),
    'console.log("agent was here");\n',
    "the agent's work must still be on disk"
  );
});

test('writeFile proceeds when the file has not changed', () => {
  const root = tmpRoot();
  const before = ws.readFile(root, 'src/index.js');
  const r = ws.writeFile(root, 'src/index.js', 'console.log(2);\n', {
    expectedHash: before.hash
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
});

test('passing no expected hash is an explicit overwrite', () => {
  // What the editor sends once a person has been shown the conflict and has
  // chosen to keep their version anyway.
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'agent\n');
  const r = ws.writeFile(root, 'src/index.js', 'person\n');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8'), 'person\n');
});

test('writeFile refuses to write outside the workspace', () => {
  const root = tmpRoot();
  assert.throws(() => ws.writeFile(root, '../escaped.js', 'x'), /escapes the workspace/);
});

/* ---------------- diff counts ---------------- */

test('diffCounts reports added and removed lines', () => {
  assert.deepEqual(ws.diffCounts('a\nb\nc\n', 'a\nb\nc\n'), { added: 0, removed: 0 });
  assert.deepEqual(ws.diffCounts('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
  assert.deepEqual(ws.diffCounts('a\nb\nc\n', 'a\n'), { added: 0, removed: 2 });
  assert.deepEqual(ws.diffCounts(null, 'a\nb\n'), { added: 3, removed: 0 });
});
