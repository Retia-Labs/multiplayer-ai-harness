#!/usr/bin/env node
'use strict';

// Checks reference-pack integrity, not rendered UI fidelity or product behavior.
const fs = require('node:fs');
const path = require('node:path');

const PACK_PATH = 'docs/design/plexus';
const TEMPLATE_IDS = ['shell', 'review', 'evidence', 'decision', 'inbox', 'setup'];
const EXPORT_PAIRS = [
  ['design/plexus-app.tokens.json', 'public/exports/plexus-app.tokens.json'],
  ['design/screen-templates.json', 'public/exports/screen-templates.json'],
  ...['DESIGN-SYSTEM.md', 'DEVELOPMENT-HANDOFF.md', 'AGENT-DEVELOPMENT.md']
    .map(name => [name, `public/exports/${name}`]),
];
const REQUIRED_FILES = [
  'README.md', 'AGENTS.md', 'AGENT-DEVELOPMENT.md', 'DESIGN-SYSTEM.md',
  'DEVELOPMENT-HANDOFF.md', 'design-qa.md', 'design/agent-instructions.md',
  'design/selected-direction.png', 'public/assets/plexus-symbol.svg',
  'public/assets/plexus-lockup.svg', 'public/assets/outfit.woff2', 'public/assets/OFL.txt',
  ...['review', 'workspace', 'activity', 'catchup', 'inbox', 'approval', 'setup', 'access', 'templates']
    .map(screen => `design/qa/${screen}-desktop.png`),
  'design/qa/review-mobile.png', 'design/qa/collaboration-mobile.png',
  'design/qa/activity-tablet.png', 'design/qa/host-unavailable.png',
];

const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const number = value => Number.isFinite(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
const boolean = value => typeof value === 'boolean';
const positiveList = value => Array.isArray(value) && value.length > 0 && value.every(positive);
const range = value => Array.isArray(value) && value.length === 2
  && value.every(positive) && value[0] <= value[1];
const color = value => {
  if (typeof value !== 'string') return false;
  if (/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
  const channels = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/.exec(value);
  return Boolean(channels && channels.slice(1, 4).every(channel => Number(channel) <= 255));
};
const typeStyle = { sizePx: positive, weight: positive, lineHeight: positive };

// This is the supported portable-token structure, not a DTCG schema. Additional
// metadata is allowed; changing these required fields is an explicit contract change.
const TOKEN_SHAPE = {
  name: string, version: string, format: string,
  provenance: { visualTarget: string, brandSource: string, spec: string, note: string },
  color: Object.fromEntries([
    'background', 'surface', 'raised', 'ink', 'muted', 'accent', 'accentInk', 'divider',
    'focus', 'warning', 'danger', 'additionBackground', 'removalBackground',
  ].map(key => [key, color])),
  type: {
    family: string, fallback: string, fontFile: string, codeFamily: string,
    pageTitle: { ...typeStyle, trackingEm: number },
    sectionTitle: { ...typeStyle, trackingEm: number },
    body: { ...typeStyle, sizeRangePx: range },
    label: { ...typeStyle, sizeRangePx: range },
    code: { ...typeStyle, lineHeightPx: positive, responsiveSizeRangePx: range },
  },
  space: { unitPx: positive, scalePx: positiveList },
  radius: {
    controlPx: nonnegative, inputPx: nonnegative, panelPx: nonnegative,
    templatePanelPx: nonnegative, largePanelPx: nonnegative, avatar: string,
    agentAvatarPx: nonnegative,
  },
  layout: {
    referenceCanvasPx: { width: positive, height: positive },
    desktopReferencePx: { width: positive, topbar: positive, sidebar: positive, inspector: positive, center: positive },
    sidebar: string, inspector: string, center: string,
    contentPaddingPx: { top: nonnegative, horizontal: nonnegative, bottom: nonnegative },
    panelGapPx: nonnegative, dividerWidthPx: positive, standardControlHeightPx: positive,
    compactControlHeightRangePx: range, touchTargetPx: positive,
    responsive: { wide: string, medium: string, narrow: string, minimumViewportWidthPx: positive },
  },
  motion: {
    interactionMs: nonnegative, entranceMs: nonnegative, staggerMs: nonnegative,
    entranceTravelPx: nonnegative, templateRevealMs: nonnegative,
    templateRevealTravelPx: nonnegative, hoverTravelPx: nonnegative,
    ease: string, reducedMotion: string, constraint: string,
  },
  accessibility: {
    bodyTextContrastTarget: positive, largeTextContrastTarget: positive,
    meaningfulControlBoundaryContrastTarget: positive, focusOutlinePx: positive,
    stateLabelRequired: boolean, decorativeDividerIsControlBoundary: boolean,
  },
};

function checkDesignContract(repoRoot) {
  const errors = [];
  const packRoot = path.resolve(repoRoot, PACK_PATH);
  const fail = message => errors.push(message);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function read(file) {
    try {
      const value = fs.readFileSync(file);
      if (!value.length) fail(`Empty required file: ${path.relative(repoRoot, file)}`);
      return value;
    } catch (error) {
      fail(`Cannot read required file ${path.relative(repoRoot, file)}: ${error.code || error.message}`);
      return null;
    }
  }

  function readJson(relativePath) {
    const value = read(path.join(packRoot, relativePath));
    if (!value) return null;
    try { return JSON.parse(value.toString('utf8')); }
    catch (error) { fail(`Invalid JSON in ${relativePath}: ${error.message}`); return null; }
  }

  function shape(value, expected, label) {
    if (typeof expected === 'function') {
      if (!expected(value)) fail(`Invalid or missing ${label} (${expected.name})`);
    } else if (!isObject(value)) {
      fail(`Invalid or missing ${label} (object)`);
    } else {
      for (const [key, rule] of Object.entries(expected)) shape(value[key], rule, `${label}.${key}`);
    }
  }

  function list(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
      fail(`Invalid or missing ${label} (nonempty array)`);
      return [];
    }
    return value;
  }

  function uniqueStrings(value, label) {
    const items = list(value, label);
    items.forEach((item, index) => shape(item, string, `${label}[${index}]`));
    if (new Set(items).size !== items.length) fail(`Duplicate values in ${label}`);
    return items;
  }

  // Resolve visual/font references inside the pack and brand provenance inside
  // the repository, never against an unrelated file on a developer's computer.
  function reference(relativePath, base, label, boundary = packRoot) {
    if (!string(relativePath)) return;
    const file = path.resolve(base, relativePath);
    const localPath = path.relative(boundary, file);
    if (path.isAbsolute(relativePath) || localPath === '..' || localPath.startsWith(`..${path.sep}`)) {
      fail(`${label} must reference a file inside ${path.relative(repoRoot, boundary) || 'the repository'}`);
      return;
    }
    read(file);
  }

  REQUIRED_FILES.forEach(file => read(path.join(packRoot, file)));
  const tokens = readJson('design/plexus-app.tokens.json');
  shape(tokens, TOKEN_SHAPE, 'tokens');
  if (isObject(tokens)) {
    reference(tokens.provenance?.visualTarget, path.join(packRoot, 'design'), 'tokens.provenance.visualTarget');
    reference(tokens.provenance?.brandSource, path.join(packRoot, 'design'), 'tokens.provenance.brandSource', path.resolve(repoRoot));
    if (string(tokens.type?.fontFile)) {
      if (!tokens.type.fontFile.startsWith('/assets/')) fail('tokens.type.fontFile must start with /assets/');
      else reference(tokens.type.fontFile.slice(1), path.join(packRoot, 'public'), 'tokens.type.fontFile');
    }
  }

  const contracts = readJson('design/screen-templates.json');
  shape(contracts, { version: string, name: string, source: string, scope: string }, 'contracts');
  if (isObject(contracts)) {
    reference(contracts.source, path.join(packRoot, 'design'), 'contracts.source');
    uniqueStrings(contracts.constraints, 'contracts.constraints');
    const templates = list(contracts.templates, 'contracts.templates');
    const ids = templates.map(template => template?.id);
    if (ids.length !== TEMPLATE_IDS.length || new Set(ids).size !== ids.length
      || TEMPLATE_IDS.some(id => !ids.includes(id))) {
      fail(`Template IDs must be exactly: ${TEMPLATE_IDS.join(', ')}`);
    }
    templates.forEach((template, index) => {
      const label = `contracts.templates[${index}]`;
      shape(template, { id: string, name: string, purpose: string }, label);
      if (!isObject(template)) return;
      const slots = list(template.slots, `${label}.slots`);
      uniqueStrings(slots.map(slot => slot?.name), `${label}.slots names`);
      slots.forEach((slot, slotIndex) => shape(slot,
        { name: string, required: boolean, content: string }, `${label}.slots[${slotIndex}]`));
      uniqueStrings(template.states, `${label}.states`);
      uniqueStrings(template.semantics, `${label}.semantics`);
    });
    const screens = list(contracts.screens, 'contracts.screens');
    uniqueStrings(screens.map(screen => screen?.id), 'contracts.screens IDs');
    screens.forEach((screen, index) => {
      const label = `contracts.screens[${index}]`;
      shape(screen, { id: string, name: string }, label);
      if (!isObject(screen)) return;
      uniqueStrings(screen.templates, `${label}.templates`).forEach(id => {
        if (!ids.includes(id)) fail(`Unknown template reference ${JSON.stringify(id)} in ${label}`);
      });
    });
  }

  for (const [source, destination] of EXPORT_PAIRS) {
    const canonical = read(path.join(packRoot, source));
    const exported = read(path.join(packRoot, destination));
    if (canonical && exported && !canonical.equals(exported)) {
      fail(`Stale export: ${destination} must exactly match ${source}`);
    }
  }

  const agents = read(path.join(repoRoot, 'AGENTS.md'));
  if (agents && !agents.toString('utf8').includes(`${PACK_PATH}/AGENT-DEVELOPMENT.md`)) {
    fail(`Root AGENTS.md must point to ${PACK_PATH}/AGENT-DEVELOPMENT.md`);
  }
  const claude = read(path.join(repoRoot, 'CLAUDE.md'));
  if (claude) {
    const claudePath = path.join(repoRoot, 'CLAUDE.md');
    const isSymlink = fs.lstatSync(claudePath).isSymbolicLink();
    const pointsToRoot = isSymlink
      ? agents !== null && fs.realpathSync(claudePath) === fs.realpathSync(path.join(repoRoot, 'AGENTS.md'))
      : /(?:^|[^\w/.-])(?:\.\/)?AGENTS\.md(?:$|[^\w/.-])/m.test(claude.toString('utf8'));
    if (!pointsToRoot) fail('Root CLAUDE.md must point to root AGENTS.md');
  }
  return errors;
}

if (require.main === module) {
  const errors = checkDesignContract(path.resolve(__dirname, '..'));
  if (errors.length) {
    console.error(`Plexus design reference checks failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Plexus design reference integrity passed. Rendered UI fidelity and behavior still require review and tests.');
  }
}

module.exports = { checkDesignContract, PACK_PATH, TEMPLATE_IDS, REQUIRED_FILES, EXPORT_PAIRS };
