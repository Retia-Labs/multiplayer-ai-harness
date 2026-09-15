'use strict';
// Founder-operated records. No payment provider, charge or notification is invoked.
const fs = require('node:fs');
const { HubStore } = require('../packages/hub/store');
const { Pilot } = require('../packages/hub/pilot');
const [operation, database, inputFile, userId] = process.argv.slice(2);
let store;
try {
  if (!['record', 'show', 'summary'].includes(operation) || !database || !fs.existsSync(database)) throw new Error('usage');
  store = new HubStore(database);
  const pilot = new Pilot(store);
  if (operation === 'record') {
    if (!inputFile) throw new Error('usage');
    const record = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const result = pilot.recordSeat(record);
    console.log(JSON.stringify({ recorded: true, revision: result.revision }));
  } else if (operation === 'show') {
    if (!inputFile || !userId) throw new Error('usage');
    console.log(JSON.stringify(pilot.seat(inputFile, userId)));
  } else console.log(JSON.stringify({ paidTeams: pilot.paidTeams() }));
} catch (error) {
  console.error(error.code || 'Usage: node scripts/pilot-seats.js record <existing-hub.sqlite> <record.json> | show <existing-hub.sqlite> <team-id> <user-id> | summary <existing-hub.sqlite>');
  process.exitCode = 1;
} finally { store?.close(); }
