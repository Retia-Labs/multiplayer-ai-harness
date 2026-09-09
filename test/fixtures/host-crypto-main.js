const { app } = require('electron');
const { attachCryptoBroker } = require('../../packages/e2ee/desktop-crypto-broker');
const path = require('node:path');
const data = process.argv.find((v) => v.startsWith('--crypto-data=')).slice('--crypto-data='.length);
app.setPath('userData', path.join(data, 'profile'));
attachCryptoBroker(process, { dataDir: path.join(data, 'keys'), diagnostics: (message) => console.error(message) });

// Keep the broker alive after its endpoint window closes until the test stops it.
app.on('window-all-closed', () => {});
