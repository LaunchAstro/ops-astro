// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody parses a provider's JSON answer and writes it back, so an escape
// cannot hide a credential spelling. An answer nested deeper than the
// engine's JSON.stringify can write back still comes back whole, through
// custody's own process, and an escaped credential deep inside it is still
// redacted.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/custody.ts';

// Synthetic fixture data only. Never use a real provider credential here.
const KEY = 'synthetic-deep-canary';
/**
 * Nestings inside the 64 KB answer limit of a replay call: 5,000 levels
 * overflow Node 24's JSON.stringify on linux arm64, 10,000 on macOS arm64.
 */
const CASES = [
  { count: '5,000', depth: 5_000, shape: 'objects' },
  { count: '5,000', depth: 5_000, shape: 'arrays' },
  { count: '10,000', depth: 10_000, shape: 'objects' },
  { count: '10,000', depth: 10_000, shape: 'arrays' },
] as const;

/** The one synthetic credential, written owner-only into `folder`. */
function credentialsIn(folder: string): string {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'deep_key',
        kind: 'api_key',
        account: 'synthetic-deep-account',
        destination: 'deep_target',
        header: 'authorization',
        value: KEY,
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

/** The raw body custody returns when the provider answers `answer`. */
async function returned(answer: string): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'custody-deep-'));
  const server = createServer((incoming, response) => {
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
    custody = await startCustody({
      credentialsFile: credentialsIn(folder),
      destinations: [{ key: 'deep_target', origin: `http://127.0.0.1:${String(address.port)}` }],
    });
    const outcome = await custody.dispatch('deep_key', {
      destination: 'deep_target',
      path: '/v1/answer',
      method: 'POST',
      body: '{}',
      timeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
    });
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    return outcome.outbound.body;
  } finally {
    await custody?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A provider answer whose metadata nests `leaf` `depth` levels deep, in objects or arrays. */
const nested = (depth: number, shape: 'objects' | 'arrays', leaf: string): string =>
  shape === 'objects'
    ? `{"text":"ok","metadata":${'{"a":'.repeat(depth)}${leaf}${'}'.repeat(depth)}}`
    : `{"text":"ok","metadata":${'['.repeat(depth)}${leaf}${']'.repeat(depth)}}`;

it.each(CASES)(
  'an answer nesting $count $shape around a plain leaf comes back whole',
  async ({ depth, shape }) => {
    const answer = nested(depth, shape, '"plain leaf"');
    const body = await returned(answer);
    expect({ length: body.length, same: body === answer }).toEqual({
      length: answer.length,
      same: true,
    });
  },
  30_000,
);

it.each(CASES)(
  'a credential escaped inside an answer nesting $count $shape is redacted and the rest comes back',
  async ({ depth, shape }) => {
    const escaped = [...KEY]
      .map((character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)
      .join('');
    const body = await returned(nested(depth, shape, `"${escaped}"`));
    expect({
      held: body.includes(KEY),
      body: body === nested(depth, shape, '"[redacted]"'),
    }).toEqual({
      held: false,
      body: true,
    });
  },
  30_000,
);
