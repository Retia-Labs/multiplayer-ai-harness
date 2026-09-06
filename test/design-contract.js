'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDesignContract, PACK_PATH, REQUIRED_FILES, EXPORT_PAIRS } = require('../scripts/check-design-contract');

const repository = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexus-design-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, PACK_PATH);
  function write(relativePath, content) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const file of REQUIRED_FILES) write(`${PACK_PATH}/${file}`, `Fixture for ${file}\n`);
  // File bytes are only existence/integrity evidence; this suite never treats
  // fixture images or the presence of screenshots as visual acceptance.
  for (const name of ['plexus-app.tokens.json', 'screen-templates.json']) {
    write(`${PACK_PATH}/design/${name}`, fs.readFileSync(path.join(repository, PACK_PATH, 'design', name)));
  }
  write('apps/web/styles.css', ':root { --bg: #080a09; }\n');
  write('AGENTS.md', `Read ${PACK_PATH}/AGENT-DEVELOPMENT.md before UI work.\n`);
  write('CLAUDE.md', 'Read [AGENTS.md](AGENTS.md) for repository instructions.\n');
  function syncExports() {
    for (const [source, destination] of EXPORT_PAIRS) {
      write(`${PACK_PATH}/${destination}`, fs.readFileSync(path.join(pack, source)));
    }
  }
  function editJson(file, edit) {
    const value = JSON.parse(fs.readFileSync(path.join(pack, file), 'utf8'));
    edit(value);
    write(`${PACK_PATH}/${file}`, `${JSON.stringify(value, null, 2)}\n`);
  }
  syncExports();
  return { root, pack, write, syncExports, editJson, check: () => checkDesignContract(root) };
}

test('a complete, synchronized reference pack passes', t => {
  assert.deepEqual(fixture(t).check(), []);
});

test('the repository CLAUDE.md symlink to root AGENTS.md is a valid entry point', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'CLAUDE.md'));
  fs.symlinkSync('AGENTS.md', path.join(f.root, 'CLAUDE.md'));
  assert.deepEqual(f.check(), []);
});

test('an unknown screen-to-template reference fails even when its export is synchronized', t => {
  const f = fixture(t);
  f.editJson('design/screen-templates.json', value => value.screens[0].templates.push('invented-layout'));
  f.syncExports();
  assert.ok(f.check().some(error => error.includes('Unknown template reference "invented-layout"')));
});

test('a missing referenced design image fails', t => {
  const f = fixture(t);
  f.editJson('design/screen-templates.json', value => { value.source = 'missing-reference.png'; });
  f.syncExports();
  assert.ok(f.check().some(error => error.includes('Cannot read required file') && error.includes('missing-reference.png')));
});

test('a stale downloadable guide fails', t => {
  const f = fixture(t);
  f.write(`${PACK_PATH}/AGENT-DEVELOPMENT.md`, 'Updated canonical workflow\n');
  assert.ok(f.check().some(error => error.includes('Stale export: public/exports/AGENT-DEVELOPMENT.md')));
});

test('stale JSON exports fail', t => {
  const f = fixture(t);
  f.editJson('design/plexus-app.tokens.json', value => { value.color.accent = '#abcdef'; });
  assert.ok(f.check().some(error => error.includes('Stale export: public/exports/plexus-app.tokens.json')));
});

test('missing or renamed canonical templates fail', t => {
  const f = fixture(t);
  f.editJson('design/screen-templates.json', value => { value.templates[0].id = 'new-shell'; });
  f.syncExports();
  assert.ok(f.check().some(error => error.includes('Template IDs must be exactly:')));
});

test('duplicate slot names and screen IDs fail', t => {
  const f = fixture(t);
  f.editJson('design/screen-templates.json', value => {
    value.templates[0].slots.push(value.templates[0].slots[0]);
    value.screens.push(value.screens[0]);
  });
  f.syncExports();
  const errors = f.check();
  assert.ok(errors.some(error => error.includes('Duplicate values') && error.includes('.slots names')));
  assert.ok(errors.some(error => error.includes('Duplicate values in contracts.screens IDs')));
});

test('invalid token types and missing token keys fail', t => {
  const f = fixture(t);
  f.editJson('design/plexus-app.tokens.json', value => {
    value.type.body.sizePx = '15px';
    delete value.color.accent;
    value.color.divider = 'rgba(999, 239, 217, 0.12)';
    value.layout.compactControlHeightRangePx = [33, 26];
  });
  f.syncExports();
  const errors = f.check();
  for (const key of ['tokens.type.body.sizePx', 'tokens.color.accent', 'tokens.color.divider', 'tokens.layout.compactControlHeightRangePx']) {
    assert.ok(errors.some(error => error.includes(key)), `Expected a failure for ${key}`);
  }
});

test('malformed JSON reports an error instead of crashing', t => {
  const f = fixture(t);
  f.write(`${PACK_PATH}/design/screen-templates.json`, '{ malformed');
  assert.ok(f.check().some(error => error.includes('Invalid JSON in design/screen-templates.json')));
});

test('visual references cannot escape the versioned design pack', t => {
  const f = fixture(t);
  f.write('outside.png', 'A file exists outside the pack');
  f.editJson('design/screen-templates.json', value => { value.source = '../../../../outside.png'; });
  f.syncExports();
  assert.ok(f.check().some(error => error.includes('contracts.source must reference a file inside docs/design/plexus')));
});

test('missing font and missing root agent pointers fail', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.pack, 'public/assets/outfit.woff2'));
  f.write('AGENTS.md', 'No design pointer\n');
  f.write('CLAUDE.md', 'Read docs/AGENTS.md only\n');
  const errors = f.check();
  assert.ok(errors.some(error => error.includes('public/assets/outfit.woff2')));
  assert.ok(errors.some(error => error.includes('Root AGENTS.md must point')));
  assert.ok(errors.some(error => error.includes('Root CLAUDE.md must point')));
});

test('a missing AGENTS.md with a misdirected CLAUDE symlink reports errors', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'AGENTS.md'));
  fs.unlinkSync(path.join(f.root, 'CLAUDE.md'));
  fs.symlinkSync(`${PACK_PATH}/AGENTS.md`, path.join(f.root, 'CLAUDE.md'));
  const errors = f.check();
  assert.ok(errors.some(error => error.includes('Cannot read required file AGENTS.md')));
  assert.ok(errors.some(error => error.includes('Root CLAUDE.md must point')));
});
