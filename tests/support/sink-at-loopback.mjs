// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only, loaded with `--import` into a process a test spawns. The made-up
// sink host `example.test` is served by the test's own loopback server on
// `TEST_SINK_PORT`, over http. The process still checks its DSN as staging
// does (a public https address, `apps/api/alerts/sink.ts`): the name resolves
// here to a public documentation address, so the sink's own check passes, and
// only the connection to that address is moved to the loopback server. The
// socket reports the address it was pinned to, as a real one would. A fetch to
// the host is moved the same way, for the senders that still use fetch.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const port = process.env['TEST_SINK_PORT'];
const HOST = 'example.test';
// What `example.test` resolves to in this process: public, never connected to.
const PUBLIC = '93.184.216.34';

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
  const lookup = dns.promises.lookup;
  dns.promises.lookup = async (host, options) => {
    if (host !== HOST) return await lookup(host, options);
    const entry = { address: PUBLIC, family: 4 };
    return options?.all === true ? [entry] : entry;
  };
  const secure = https.request;
  https.request = (options, callback) => {
    if (options?.servername !== HOST) return secure(options, callback);
    const { servername: _name, lookup: _pin, ca: _ca, ...plain } = options;
    const outgoing = http.request({ ...plain, host: '127.0.0.1', port: Number(port) }, callback);
    outgoing.on('socket', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { get: () => PUBLIC });
    });
    return outgoing;
  };
  syncBuiltinESMExports();
}
