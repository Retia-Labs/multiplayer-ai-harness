'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');

function desktopProfile({ userData, hubUrl, dataRoot }) {
  const url = new URL(hubUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_hub_address');
  }
  // URL canonicalization removes default ports and normalizes scheme/host spelling.
  // Retain a service path, but treat its optional trailing slash consistently.
  const normalized = url.origin + url.pathname.replace(/\/+$/, '');
  const id = createHash('sha256').update(normalized).digest('hex');
  const base = dataRoot ? path.resolve(dataRoot) : path.join(userData, 'harness');
  return { id, hubUrl: normalized, partition: 'persist:plexus-app-' + id,
    dataDir: path.join(base, 'hubs', id), localHubDatabase: path.join(base, 'hub.sqlite') };
}

module.exports = { desktopProfile };
