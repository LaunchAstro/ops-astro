// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01, the egress conformance proof: ten cases.
//
// A model call leaves the machine only from custody's process, only to a
// destination on custody's own list, and never by a redirect. The broker's
// process opens no connection for it (case 9 watches every client socket
// Node creates while a dispatch runs), and no product module outside the
// closed list below holds a network primitive (case 10, a scanner with its
// hostile cases). Any other network call fails this proof.

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseDestinations } from '../../packages/core-custody/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from './custody-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Every place product code may touch the network, and why. A new one is a
 * reviewed line here, never a quiet import.
 */
const NETWORK_SITES: Readonly<Record<string, string>> = {
  'packages/core-custody/src/egress.ts': 'the one outbound path of a model call',
  'packages/core-custody/src/custody.ts': "starts custody's own process",
  'packages/core-connectors/src/replay.ts':
    'the replay stand-in listens on loopback; it calls nothing',
  'apps/api/server.ts': "the API serves its own routes on loopback; `app.fetch` is Hono's handler",
  'apps/web/src/main.tsx': "the browser's own fetch, bound once at the composition root",
  'apps/web/src/App.tsx': "threads that fetch to the product's own API, same origin",
  'apps/web/src/screens/SignIn.tsx': "threads that fetch to the product's own sign-in route",
  'apps/cli/main.ts': "the command line calls the product's own API",
  // Main's core after the slice's base (rebase onto 8eba5e6):
  'apps/cli/client.ts':
    "the command line's and the worker's one transport to the product's own API (T2b)",
  'apps/api/identity.ts':
    'runs the local git once at process start to read its own checkout (T4); no network',
  'apps/web/src/operations/client.ts': "the browser calls the product's own API, same origin",
  'apps/web/src/session/sign-in.ts':
    "the browser signs in through the product's own API, same origin",
};

const MODULES =
  'http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|undici|inspector';
const PRIMITIVES = [
  new RegExp(`['"\`]\\s*(?:node:)?(?:${MODULES})(?:/[a-z]+)?\\s*['"\`]`, 'u'),
  /(?<![\w$.])(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
  /\.\s*(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u,
  /\[\s*['"`](?:fetch|XMLHttpRequest|WebSocket|EventSource)['"`]\s*\]/u,
  /new\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/u,
];

/** Unicode escapes spelled out, then comments kept (a commented import is still read: it costs nothing to flag). */
function normalise(source: string): string {
  return source
    .replaceAll(/\\u\{([0-9a-f]+)\}/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function holdsNetworkPrimitive(source: string): boolean {
  const text = normalise(source);
  return PRIMITIVES.some((pattern) => pattern.test(text));
}

function productSources(): readonly string[] {
  return execFileSync('git', ['ls-files', '--', 'packages', 'apps'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file))
    .filter((file) => !/\.(?:test|spec)\./u.test(file));
}

let world: CustodyWorld;

beforeAll(async () => {
  world = await openCustodyWorld();
});

afterAll(async () => {
  await world?.close();
});

it('AW-01 egress 1: a listed destination is reached once, at the origin custody holds', async () => {
  world.provider.mode('answer');
  const before = world.provider.seen.length;
  const outcome = await world.custody.dispatch('replay_key', world.request());
  expect(outcome.kind === 'answered' && outcome.outbound.ok).toBe(true);
  expect(world.provider.seen.length).toBe(before + 1);
  expect(world.provider.seen.at(-1)?.path).toBe('/v1/complete');
});

it('AW-01 egress 2: a destination custody does not list is refused before any connection', async () => {
  const before = world.provider.seen.length;
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ destination: 'elsewhere' }),
  );
  expect(outcome.kind).toBe('refused');
  expect(world.provider.seen.length).toBe(before);
});

it('AW-01 egress 3: a redirect is never followed, to an unlisted host or any other', async () => {
  world.provider.mode('redirect');
  const before = world.provider.seen.length;
  const outcome = await world.custody.dispatch('replay_key', world.request());
  expect(outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault).toBe(
    'redirect',
  );
  expect(world.provider.seen.length).toBe(before + 1);
});

it('AW-01 egress 4: the caller cannot name a destination through the path', async () => {
  const before = world.provider.seen.length;
  for (const path of [
    '//203.0.113.9/v1/complete',
    'http://203.0.113.9/v1/complete',
    '/v1/../../etc',
    '/v1/complete?to=http://203.0.113.9',
    '/v1/%2F%2F203.0.113.9',
    '\t/v1/complete',
    '/v1/complete\n',
    '@203.0.113.9/v1',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await world.custody.dispatch('replay_key', world.request({ path }));
    expect(outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault).toBe(
      'bad_path',
    );
  }
  expect(world.provider.seen.length).toBe(before);
});

it('AW-01 egress 5: an answer past the timeout ends at the timeout', async () => {
  world.provider.mode('slow');
  const outcome = await world.custody.dispatch('replay_key', world.request({ timeoutMs: 250 }));
  expect(outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault).toBe(
    'timeout',
  );
});

it('AW-01 egress 6: an answer past the size limit is cut off, not read to the end', async () => {
  world.provider.mode('oversized');
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ maxResponseBytes: 1024 }),
  );
  expect(outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault).toBe(
    'too_large',
  );
});

it('AW-01 egress 7: a metadata or link-local host is never a destination', () => {
  for (const origin of [
    'http://169.254.169.254',
    'http://[fd00:ec2::254]',
    'http://metadata.google.internal',
    'http://[fe80::1]',
    'http://0.0.0.0',
  ]) {
    const parsed = parseDestinations([{ key: 'bad', origin }]);
    expect(parsed.ok ? 'accepted' : parsed.code, origin).toMatch(
      /DESTINATION_(FORBIDDEN|MALFORMED)/u,
    );
  }
});

it('AW-01 egress 8: a destination is a bare http or https origin, nothing more', () => {
  for (const origin of [
    'file:///etc/passwd',
    'data:text/plain,x',
    'ftp://example.test',
    'https://user:secret@example.test',
    'https://example.test/v1',
    'https://example.test?x=1',
    'https://EXAMPLE.test',
    ' https://example.test',
  ]) {
    expect(parseDestinations([{ key: 'bad', origin }]).ok, origin).toBe(false);
  }
  expect(parseDestinations([{ key: 'good', origin: 'https://example.test' }]).ok).toBe(true);
  expect(
    parseDestinations([
      { key: 'twice', origin: 'https://example.test' },
      { key: 'twice', origin: 'https://example.test' },
    ]).ok,
  ).toBe(false);
});

it("AW-01 egress 9: the broker's process opens no connection while a dispatch runs", async () => {
  const sockets: string[] = [];
  const seen = (message: unknown): void => {
    const socket = (message as { socket?: { remoteAddress?: string } }).socket;
    sockets.push(String(socket?.remoteAddress ?? 'pending'));
  };
  subscribe('net.client.socket', seen);
  try {
    world.provider.mode('answer');
    const outcome = await world.custody.dispatch('replay_key', world.request());
    expect(outcome.kind === 'answered' && outcome.outbound.ok).toBe(true);
  } finally {
    unsubscribe('net.client.socket', seen);
  }
  expect(sockets).toEqual([]);
  // The channel is live: a connection made here is seen.
  subscribe('net.client.socket', seen);
  try {
    await fetch(`${world.provider.origin}/v1/complete`, { method: 'POST', body: '{}' });
  } finally {
    unsubscribe('net.client.socket', seen);
  }
  expect(sockets.length).toBeGreaterThan(0);
});

it('AW-01 egress 10: no product module outside the closed list holds a network primitive', () => {
  const holding = productSources().filter((file) =>
    holdsNetworkPrimitive(readFileSync(resolve(ROOT, file), 'utf8')),
  );
  expect(holding.toSorted()).toEqual(Object.keys(NETWORK_SITES).toSorted());
});

const caught = [
  "import { request } from 'node:http';",
  'import { request } from "https";',
  'import net from `net`;',
  "const m = await import ( 'node:net' );",
  "const m = await import(\t'node:tls'\t);",
  "const c = require('child_process');",
  "import { connect } from 'node:http2';",
  "import { Agent } from 'undici';",
  "import dns from 'node:dns/promises';",
  'await fetch(url);',
  'await globalThis.fetch(url);',
  "await globalThis['fetch'](url);",
  'await globalThis [ "fetch" ] (url);',
  'await \\u0066etch(url);',
  "import x from 'node:\\u0068ttp';",
  'new WebSocket(url);',
  'new XMLHttpRequest();',
  '// import { request } from "node:http";',
  "/* require('net') */",
];
const clean = [
  "import { readFileSync } from 'node:fs';",
  'const prefetch = 1;',
  'function fetched() {}',
  "const word = 'network';",
  "import { x } from './http-shape.ts';",
];

it.each(caught)('flags %s', (source) => {
  expect(holdsNetworkPrimitive(source)).toBe(true);
});

it.each(clean)('passes %s', (source) => {
  expect(holdsNetworkPrimitive(source)).toBe(false);
});
