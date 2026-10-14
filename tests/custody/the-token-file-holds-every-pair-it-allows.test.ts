// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 4 (F9): one encoder bounds every record. The largest valid
// file is exactly 51,346 bytes, below 65,536; one character more in any field
// is refused by the encoder, never by the reader. The locked reader refuses a
// token file others could swap or read.

import { chmodSync, openSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import {
  FIELD_MAX,
  TOKEN_FILE_BYTES,
  encodeTokenFile,
  readTokenFileLocked,
  type PlanTokens,
  type TokenFile,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import { HOUR, T0, fileBytes, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};
const fill = (n: number) => 'x'.repeat(n);
const largest: PlanTokens = {
  clientId: fill(FIELD_MAX.clientId),
  accessToken: fill(FIELD_MAX.accessToken),
  refreshToken: fill(FIELD_MAX.refreshToken),
  subject: fill(FIELD_MAX.subject),
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const read = (file: string) =>
  withTokenLock(file, { deadlineAt: Date.now() + 2_000 }, (held) =>
    Promise.resolve(readTokenFileLocked(held, file)),
  );

it('the largest pending record encodes to exactly 51,346 bytes and reads back', async () => {
  const record: TokenFile = { state: 'pending', tokens: largest, since: Number.MAX_SAFE_INTEGER };
  const bytes = encodeTokenFile(record);
  expect(Buffer.isBuffer(bytes) ? bytes.length : bytes).toBe(51_346);
  expect(51_346).toBeLessThan(TOKEN_FILE_BYTES);
  const { file } = world();
  await seed(file, record);
  expect(await read(file)).toEqual({ held: true, value: record });
});

it('one character more in each field, a quote, a backslash and an extra key are refused by the encoder', () => {
  for (const key of ['clientId', 'accessToken', 'refreshToken', 'subject'] as const) {
    const over = { ...largest, [key]: fill(FIELD_MAX[key] + 1) };
    expect(encodeTokenFile({ state: 'ready', tokens: over })).toBe('NOT_TOKENS');
  }
  expect(
    encodeTokenFile({ state: 'ready', tokens: { ...largest, accessToken: 'synthetic-"quote' } }),
  ).toBe('NOT_TOKENS');
  expect(
    encodeTokenFile({ state: 'ready', tokens: { ...largest, accessToken: 'synthetic-\\slash' } }),
  ).toBe('NOT_TOKENS');
  const extra = { state: 'ready', tokens: largest, note: 'synthetic' } as unknown as TokenFile;
  expect(encodeTokenFile(extra)).toBe('NOT_TOKENS');
  const extraToken = {
    state: 'ready',
    tokens: { ...largest, scope: 'synthetic' },
  } as unknown as TokenFile;
  expect(encodeTokenFile(extraToken)).toBe('NOT_TOKENS');
  expect(encodeTokenFile({ state: 'ready', tokens: { ...largest, expiresAt: -1 } })).toBe(
    'NOT_TOKENS',
  );
});

it("Sol's 32,768 + 32,768 pair is refused before any write", () => {
  const pair = { ...largest, accessToken: fill(32_768), refreshToken: fill(32_768) };
  expect(encodeTokenFile({ state: 'ready', tokens: pair })).toBe('NOT_TOKENS');
});

it('the reader refuses a symlinked token file, mode 0644, 65,537 bytes and a swapped inode', async () => {
  const linked = world();
  await seed(linked.file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  renameSync(linked.file, `${linked.dir}/real`);
  symlinkSync(`${linked.dir}/real`, linked.file);
  expect(await read(linked.file)).toEqual({
    held: true,
    value: { state: 'refused', code: 'SUBSCRIPTION_TOKEN_FILE_OPEN' },
  });

  const open = world();
  await seed(open.file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  chmodSync(open.file, 0o644);
  expect(await read(open.file)).toEqual({
    held: true,
    value: { state: 'refused', code: 'SUBSCRIPTION_TOKEN_FILE_OPEN' },
  });

  const big = world();
  writeFileSync(big.file, fill(65_537), { mode: 0o600 });
  expect(await read(big.file)).toEqual({
    held: true,
    value: { state: 'refused', code: 'SUBSCRIPTION_SIGN_IN_NEEDED' },
  });

  const swapped = world();
  await seed(swapped.file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  const hostile = world();
  writeFileSync(`${hostile.dir}/other`, fileBytes(swapped.file), { mode: 0o600 });
  const out = await withTokenLock(swapped.file, { deadlineAt: Date.now() + 2_000 }, (held) =>
    Promise.resolve(
      readTokenFileLocked(held, swapped.file, {
        openSync: (path, flags) => {
          renameSync(`${hostile.dir}/other`, String(path));
          return openSync(path, flags);
        },
      }),
    ),
  );
  expect(out).toEqual({
    held: true,
    value: { state: 'refused', code: 'SUBSCRIPTION_TOKEN_FILE_OPEN' },
  });
});

it('healthy: an ordinary pair commits and reads back under the lock', async () => {
  const { file } = world();
  const record: TokenFile = { state: 'ready', tokens: tokens('a', T0 + HOUR) };
  await seed(file, record);
  expect(await read(file)).toEqual({ held: true, value: record });
});

// P1b: the holder's answers to rotated pairs it cannot store whole.

const due: TokenFile = { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) };
it('a rotated refresh token over its maximum leaves pending', async () => {
  const { file } = world();
  await seed(file, due);
  issuer.set({
    kind: 'json',
    status: 200,
    body: { access_token: 'synthetic-access-new', refresh_token: fill(16_385), expires_in: 3_600 },
  });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(fileBytes(file).toString('latin1')).toMatch(/^\{"state":"pending"/u);
});

it('an over-long rotated access token keeps the rotated refresh token (rotated_only)', async () => {
  const { file } = world();
  await seed(file, due);
  issuer.set({
    kind: 'json',
    status: 200,
    body: { access_token: fill(32_769), refresh_token: 'synthetic-refresh-new', expires_in: 3_600 },
  });
  const logs: string[] = [];
  const holder = tokenHolder({
    file,
    tokenUrl: issuer.url,
    now: () => T0,
    log: (k) => logs.push(k),
  });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(logs).toContain('token rotated only');
  expect(await read(file)).toEqual({
    held: true,
    value: {
      state: 'ready',
      tokens: { ...due.tokens, refreshToken: 'synthetic-refresh-new', expiresAt: T0 },
    },
  });
});

it('healthy: an ordinary pair is held and presented', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: true });
  expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-a' });
});
