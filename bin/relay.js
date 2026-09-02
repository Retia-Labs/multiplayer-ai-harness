#!/usr/bin/env node
/**
 * Run a relay.
 *
 * This is the only piece anybody has to host, and it is deliberately tiny: it
 * stores no code, runs no agent, and holds nothing but a mirrored copy of
 * whatever the runs in its rooms chose to publish. Losing it loses no work -
 * every run keeps its own log on the machine doing the work.
 *
 *   node bin/relay.js --port 7788
 *
 * For a team, put it on any small box with a public address and point everyone
 * at it in Settings. For two people on the same network, one of you runs this.
 */
const { createRelay } = require('../src/relay/relay');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', process.env.PORT || 7788));
const host = arg('host', '0.0.0.0');
const ttlHours = Number(arg('ttl-hours', 12));
const maxRooms = Number(arg('max-rooms', 500));

const relay = createRelay({ ttlMs: ttlHours * 3600 * 1000, maxRooms });

relay
  .listen(port, host)
  .then((addr) => {
    console.log('Quorum relay listening on http://' + host + ':' + addr.port);
    console.log('Rooms expire after ' + ttlHours + 'h of silence. Max ' + maxRooms + ' rooms.');
    console.log('Point desktops at this address in Settings, then Share a run.');
  })
  .catch((err) => {
    console.error('Could not start the relay:', err.message);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nClosing rooms…');
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
