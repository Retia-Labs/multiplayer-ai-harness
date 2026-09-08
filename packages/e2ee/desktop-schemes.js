'use strict';
// Electron accepts this registration once, before ready. Both bundled origins must be
// declared together so loading the broker cannot remove fetch support from the app.
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged(['plexus-app', 'plexus-host-crypto'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
})));
