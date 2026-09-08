import * as sdk from './vendor/index.mjs';
import { createEndpointAPI } from './endpoint-core.mjs';
const { Endpoint } = createEndpointAPI(sdk);
let endpoint;
const methods = new Set(['track', 'peerEndpoints', 'confirmEndpoint', 'isEndpointVerified', 'sealControl', 'openControl', 'open',
  'shareVerifiedTaskKey', 'encryptTask', 'decryptVerifiedTask', 'rotateTaskKey', 'exportHistory', 'importHistory', 'sign', 'close']);
globalThis.plexusHostCrypto = async (method, args) => {
  if (method === 'create') {
    if (endpoint) throw new Error('crypto_endpoint_already_open');
    const options = args[0];
    const key = await globalThis.plexusCrypto.storeKey();
    const transport = {
      send: (type, value) => globalThis.plexusCrypto.transport('send', [type, value]),
      deliverToDevice: (...values) => globalThis.plexusCrypto.transport('deliverToDevice', values),
      drain: () => globalThis.plexusCrypto.transport('drain', [])
    };
    endpoint = await Endpoint.create({ user: options.user, device: options.device,
      storeName: 'plexus-host-' + options.device, storeKey: key, transport });
    return endpoint.identity();
  }
  if (!endpoint || !methods.has(method)) throw new Error('unknown_endpoint_operation');
  if (method === 'decryptVerifiedTask' && args[3]?.admittedSessions) args[3].admittedSessions = new Set(args[3].admittedSessions);
  const result = await endpoint[method](...args);
  if (method === 'close') endpoint = null;
  return result;
};
