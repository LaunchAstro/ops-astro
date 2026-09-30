// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only, loaded with `--import` into a process a test spawns. The made-up
// sink host `example.test` is served by the test's own loopback server on
// `TEST_SINK_PORT`, over http. The process still checks its DSN as staging
// does (a public https address, `apps/api/alerts/sink.ts`): only the request
// leaving fetch is moved.

const port = process.env['TEST_SINK_PORT'];
const fetched = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'example.test' && port) {
    url.protocol = 'http:';
    url.host = `127.0.0.1:${port}`;
  }
  return fetched(url, init);
};
