// SPDX-License-Identifier: AGPL-3.0-only
//
// A refresh the provider answered 200 but the holder cannot use (#1620): the
// provider has already spent the old refresh token, so a new one it sent is
// written, due at once, and the next call refreshes with it, never with the
// spent one. Controls: an answer with no new refresh token leaves the file as
// it was, and a long access token is a usable one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  readTokenFile,
  tokenHolder,
  writeTokenFile,
} from '../../packages/core-custody/src/plan-token.ts';

let folder: string;
let file: string;
const clock = 1_000_000;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'plan-unusable-'));
  file = join(folder, 'tokens.json');
  writeTokenFile(file, {
    clientId: 'oaiapp_fake',
    accessToken: 'access-spent-secret',
    refreshToken: 'refresh-one-secret',
    expiresAt: clock - 1,
  });
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A holder whose provider answers each refresh with the next body, recording what it was sent. */
function holderAnswering(bodies: unknown[]) {
  const sent: string[] = [];
  const holder = tokenHolder({
    file,
    tokenUrl: 'https://issuer.example.test/token',
    now: () => clock,
    fetch: (_url, init) => {
      sent.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '');
      return Promise.resolve(Response.json(bodies.shift() ?? {}));
    },
  });
  return { holder, sent };
}

const held = () => {
  const read = readTokenFile(file);
  if (typeof read === 'string') throw new Error(read);
  return read;
};

it('a 200 missing its expiry keeps the rotated refresh token, and the next call refreshes with it', async () => {
  const { holder, sent } = holderAnswering([
    { access_token: 'access-two-secret', refresh_token: 'refresh-two-secret' },
    {
      access_token: 'access-three-secret',
      refresh_token: 'refresh-three-secret',
      expires_in: 3600,
    },
  ]);
  expect(await holder.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(held()).toMatchObject({ refreshToken: 'refresh-two-secret', expiresAt: clock });
  expect(await holder.current()).toEqual({ ok: true, accessToken: 'access-three-secret' });
  expect(sent).toEqual(['refresh-one-secret', 'refresh-two-secret']);
});

it('control: a 200 with no new refresh token leaves the file as it was', async () => {
  const { holder } = holderAnswering([{ access_token: 'access-two-secret' }]);
  expect(await holder.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(held()).toMatchObject({ refreshToken: 'refresh-one-secret', expiresAt: clock - 1 });
});

it('control: a long access token is a usable one', async () => {
  const long = `access-${'x'.repeat(10_000)}`;
  const { holder } = holderAnswering([
    { access_token: long, refresh_token: 'refresh-two-secret', expires_in: 3600 },
  ]);
  expect(await holder.current()).toEqual({ ok: true, accessToken: long });
});
