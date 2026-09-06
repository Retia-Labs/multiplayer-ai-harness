import * as sdk from './vendor/index.mjs';
import { createEndpointAPI } from './endpoint-core.mjs';
import { HttpKeyTransport } from './http-transport.mjs';
const { Endpoint } = createEndpointAPI(sdk);
let endpoint;
globalThis.e2eeProof = {
  async create(options) {
    const storeKey = options.desktopStore ? await globalThis.proofDesktop.storeKey() : options.storeKey;
    endpoint = await Endpoint.create({ ...options, storeKey, transport: new HttpKeyTransport(options.transport) });
    return endpoint.identity();
  },
  async call(method, ...args) {
    if (!endpoint || !['track', 'confirmEndpoint', 'isEndpointVerified', 'sealTo', 'sealControl', 'openControl',
      'open', 'shareTaskKey', 'shareVerifiedTaskKey', 'encryptTask', 'decryptTask', 'rotateTaskKey', 'exportHistory', 'importHistory', 'identity', 'close'].includes(method)) {
      throw new Error('unknown_endpoint_operation');
    }
    return endpoint[method](...args);
  },
  async transport(method, ...args) {
    if (!['drain', 'putTask', 'tasks', 'backup', 'restore', 'deliverToDevice'].includes(method)) throw new Error('unknown_transport_operation');
    return endpoint.transport[method](...args);
  }
};
