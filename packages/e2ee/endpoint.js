'use strict';
const sdk = require('@matrix-org/matrix-sdk-crypto-wasm');
const { createEndpointAPI } = require('./endpoint-core.mjs');
module.exports = createEndpointAPI(sdk);
