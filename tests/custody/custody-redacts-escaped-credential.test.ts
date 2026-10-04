// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/custody.ts';
import { parseDestinations, type OutboundRequest } from '../../packages/core-custody/src/egress.ts';

// Synthetic fixture data only. Never use a real provider credential here.
const KEY = 'sol-ow018/fake-canary-key';
const request: OutboundRequest = {
  destination: 'auth_target',
  path: '/auth/v1/admin/users',
  method: 'POST',
  body: '{}',
  timeoutMs: 2_000,
  maxResponseBytes: 4_096,
};

/** The one synthetic credential, written owner-only into `folder`. */
function credentialsIn(folder: string, value: string): string {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'auth_key',
        kind: 'api_key',
        account: 'synthetic-auth-account',
        destination: 'auth_target',
        header: 'authorization',
        value,
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

async function withCustody(
  extra: Record<string, unknown>,
  answer: string,
  check: (
    custody: Awaited<ReturnType<typeof startCustody>>,
    seen: IncomingHttpHeaders[],
  ) => Promise<void>,
  key: string = KEY,
): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'sol-ow018-'));
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((incoming, response) => {
    seen.push(incoming.headers);
    incoming.resume();
    incoming.on('end', () =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(answer),
    );
  });
  let custody: Awaited<ReturnType<typeof startCustody>> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server has no port');
    const credentialsFile = credentialsIn(folder, key);
    const parsed = parseDestinations([
      {
        key: 'auth_target',
        origin: `http://127.0.0.1:${String(address.port)}`,
        ...extra,
      },
    ]);
    if (!parsed.ok) throw new Error(`destination refused: ${parsed.code}`);
    custody = await startCustody({
      credentialsFile,
      destinations: [...parsed.destinations.values()],
    });
    await check(custody, seen);
  } finally {
    await custody?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(folder, { recursive: true, force: true });
  }
}

it('lowercase percent escapes cannot carry a credential in the decoded answer', async () => {
  const escaped = encodeURIComponent(KEY).replaceAll('%2F', '%2f');
  await withCustody({}, JSON.stringify({ text: escaped }), async (custody) => {
    const outcome = await custody.dispatch('auth_key', request);
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    const decoded: unknown = JSON.parse(outcome.outbound.body);
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('text' in decoded) ||
      typeof decoded.text !== 'string'
    ) {
      throw new Error('not a text answer');
    }
    expect(
      decodeURIComponent(decoded.text).includes(KEY),
      'decoded answer must not hold the key',
    ).toBe(false);
  });
});

it('every character percent-escaped, in mixed hex case, is redacted from the answer', async () => {
  const escaped = [...Buffer.from(KEY, 'utf8')]
    .map((byte, at) => {
      const hex = byte.toString(16).padStart(2, '0');
      return `%${at % 2 === 0 ? hex : hex.toUpperCase()}`;
    })
    .join('');
  await withCustody({}, JSON.stringify({ text: escaped }), async (custody) => {
    const outcome = await custody.dispatch('auth_key', request);
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    expect(
      decodeURIComponent(outcome.outbound.body).includes(KEY),
      'decoded answer must not hold the key',
    ).toBe(false);
    expect(outcome.outbound.body).toContain('[redacted]');
  });
});

/** The answer custody returned for `text`, as a consumer reads it back. */
async function answered(text: string, key: string): Promise<string> {
  let body = '';
  await withCustody(
    {},
    JSON.stringify({ text }),
    async (custody) => {
      const outcome = await custody.dispatch('auth_key', request);
      if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
      body = outcome.outbound.body;
    },
    key,
  );
  const decoded: unknown = JSON.parse(body);
  if (typeof decoded !== 'object' || decoded === null || !('text' in decoded)) return '';
  return String(decoded.text);
}

it('a key with a quote, JSON-escaped beside a percent escape, is redacted from the answer', async () => {
  const key = 'synthetic"canary-key-0123';
  const text = await answered(key.replace('y-', '%79-'), key);
  expect(decodeURIComponent(text).includes(key), 'decoded answer must not hold the key').toBe(
    false,
  );
});

it.each([
  [
    'base64 without padding',
    (key: string) => Buffer.from(key).toString('base64').replace(/=+$/u, ''),
  ],
  ['base64url', (key: string) => Buffer.from(key).toString('base64url')],
] as const)('the key in %s is redacted from the answer', async (_case, spell) => {
  const text = await answered(spell(KEY), KEY);
  expect(
    Buffer.from(text, 'base64').toString('utf8').includes(KEY),
    'decoded answer must not hold the key',
  ).toBe(false);
});
