// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only, loaded with `--import` into a process a test spawns. The made-up
// sink host `example.test` is served by the test's own loopback server on
// `TEST_SINK_PORT`, over http. The process still checks its DSN as staging
// does (`apps/api/alerts/dsn-transport.ts`): the name resolves to a public
// address, the send is pinned to it, and only the platform underneath is
// moved. The lookup answers a public stand-in, the pinned request goes to the
// loopback server instead, and its socket reports the stand-in, so the
// product's checks run unchanged and nothing in the product admits loopback.
// The heartbeat still uses fetch, so a fetch to the host is moved too.

import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const port = process.env['TEST_SINK_PORT'];
const HOST = 'example.test';
// A public address the classifier admits; nothing ever connects to it.
const STAND_IN = '93.184.215.14';

const fetched = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === HOST && port) {
    url.protocol = 'http:';
    url.host = `127.0.0.1:${port}`;
  }
  return fetched(url, init);
};

if (port) {
  const dns = require('node:dns/promises');
  const https = require('node:https');
  const http = require('node:http');
  const lookup = dns.lookup;
  dns.lookup = (host, options) => {
    if (host !== HOST) return lookup(host, options);
    const answer = { address: STAND_IN, family: 4 };
    return Promise.resolve(options?.all ? [answer] : answer);
  };
  const request = https.request;
  https.request = (options, callback) => {
    if (typeof options !== 'object' || options instanceof URL || options.host !== HOST) {
      return request(options, callback);
    }
    const { method, path, headers } = options;
    const outgoing = http.request(
      { host: '127.0.0.1', port: Number(port), method, path, headers, agent: false },
      callback,
    );
    // Registered before the caller's own listener, so its check reads the stand-in.
    outgoing.on('socket', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { get: () => STAND_IN });
    });
    return outgoing;
  };
  syncBuiltinESMExports();
}
