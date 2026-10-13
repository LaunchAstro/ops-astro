// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan token in custody on the owner's machine (#1620):
// refreshed at its earliest refresh time on a faked clock, the rotated
// refresh token written owner-only before the new access token is used, one
// refresh for any number of calls that ask at once, a refused refresh
// stopping every call until the owner signs in again, and a failed one
// refusing that call only. The provider is a fake token endpoint on loopback.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  REFRESH_AHEAD_MS,
  tokenHolder,
  type PlanTokens,
} from '../../packages/core-custody/src/plan-token.ts';

interface FakeIssuer {
  readonly tokenUrl: string;
  /** Each refresh asked for, as the form it sent. */
  readonly asked: URLSearchParams[];
  answer: (form: URLSearchParams) => { status: number; body: unknown };
  close(): Promise<void>;
}

async function fakeIssuer(): Promise<FakeIssuer> {
  const issuer = {
    asked: [] as URLSearchParams[],
    answer: (_form: URLSearchParams) => ({ status: 500, body: {} }),
  };
  let turn = 0;
  const server: Server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => {
      const form = new URLSearchParams(text);
      issuer.asked.push(form);
      turn += 1;
      const { status, body } = issuer.answer(form);
      // A slow answer, so calls that ask meanwhile meet the one in flight.
      setTimeout(() => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      }, 20 * turn);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(issuer, {
    tokenUrl: `http://127.0.0.1:${String(port)}/oauth/token`,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}

const HOUR = 3_600_000;
let folder: string;
let file: string;
let issuer: FakeIssuer;
let clock: number;

const first: PlanTokens = {
  clientId: 'app_fake_client',
  accessToken: 'access-one-xxxxxxxx',
  refreshToken: 'refresh-one-xxxxxxxx',
  expiresAt: 10 * HOUR,
};

const rotated = (form: URLSearchParams) => ({
  status: 200,
  body: {
    access_token: `access-after-${form.get('refresh_token') ?? ''}`,
    refresh_token: `rotated-${form.get('refresh_token') ?? ''}`,
    expires_in: 3600,
  },
});

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'plan-token-'));
  file = join(folder, 'chatgpt-plan.json');
  writeFileSync(file, JSON.stringify(first), { mode: 0o600 });
  issuer = await fakeIssuer();
  clock = 0;
});

afterEach(async () => {
  await issuer.close();
  rmSync(folder, { recursive: true, force: true });
});

const holder = () => tokenHolder({ file, tokenUrl: issuer.tokenUrl, now: () => clock });

it('before its earliest refresh time the held access token is used and nothing is asked', async () => {
  clock = first.expiresAt - REFRESH_AHEAD_MS - 1;
  expect(await holder().current()).toEqual({ ok: true, accessToken: first.accessToken });
  expect(issuer.asked).toHaveLength(0);
});

it('at its earliest refresh time it refreshes, and the rotated pair is written owner-only before use', async () => {
  issuer.answer = rotated;
  const held = holder();
  clock = first.expiresAt - REFRESH_AHEAD_MS;
  const answer = await held.current();
  expect(answer).toEqual({ ok: true, accessToken: 'access-after-refresh-one-xxxxxxxx' });
  expect(issuer.asked).toHaveLength(1);
  expect(issuer.asked[0]?.get('grant_type')).toBe('refresh_token');
  expect(issuer.asked[0]?.get('client_id')).toBe(first.clientId);
  const written = JSON.parse(readFileSync(file, 'utf8')) as PlanTokens;
  expect(written).toEqual({
    clientId: first.clientId,
    accessToken: 'access-after-refresh-one-xxxxxxxx',
    refreshToken: 'rotated-refresh-one-xxxxxxxx',
    expiresAt: clock + HOUR,
  });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('across two expiries each refresh sends the rotated refresh token, never the spent one', async () => {
  issuer.answer = rotated;
  const held = holder();
  clock = first.expiresAt;
  await held.current();
  clock += HOUR;
  const second = await held.current();
  expect(issuer.asked.map((form) => form.get('refresh_token'))).toEqual([
    'refresh-one-xxxxxxxx',
    'rotated-refresh-one-xxxxxxxx',
  ]);
  expect(second).toEqual({ ok: true, accessToken: 'access-after-rotated-refresh-one-xxxxxxxx' });
});

it('calls that ask at once past expiry share one refresh', async () => {
  issuer.answer = rotated;
  const held = holder();
  clock = first.expiresAt + 1;
  const answers = await Promise.all([held.current(), held.current(), held.current()]);
  expect(issuer.asked).toHaveLength(1);
  expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
});

it('a refused refresh needs a new sign-in: every call is refused and nothing more is asked', async () => {
  issuer.answer = () => ({ status: 400, body: { error: 'invalid_grant' } });
  const held = holder();
  clock = first.expiresAt;
  expect(await held.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(await held.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(issuer.asked).toHaveLength(1);
  // The owner signs in again: the file holds a new pair, and calls go on.
  writeFileSync(
    file,
    JSON.stringify({ ...first, refreshToken: 'refresh-two-xxxxxxxx', expiresAt: clock + HOUR }),
    { mode: 0o600 },
  );
  expect(await held.current()).toEqual({ ok: true, accessToken: first.accessToken });
});

it('a refresh that fails on the way refuses that call only; the next call tries again', async () => {
  issuer.answer = () => ({ status: 503, body: {} });
  const held = holder();
  clock = first.expiresAt;
  expect(await held.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  issuer.answer = rotated;
  expect(await held.current()).toEqual({
    ok: true,
    accessToken: 'access-after-refresh-one-xxxxxxxx',
  });
  expect(issuer.asked).toHaveLength(2);
});

it('a token file others can read is never used', async () => {
  chmodSync(file, 0o644);
  expect(await holder().current()).toEqual({ ok: false, code: 'SUBSCRIPTION_TOKEN_FILE_OPEN' });
});

it('with no token file yet the owner has not signed in', async () => {
  rmSync(file);
  expect(await holder().current()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
});

it('the holder logs kinds only, never a token', async () => {
  issuer.answer = rotated;
  const said: string[] = [];
  const held = tokenHolder({
    file,
    tokenUrl: issuer.tokenUrl,
    now: () => clock,
    log: (kind) => said.push(kind),
  });
  clock = first.expiresAt;
  await held.current();
  expect(said).toEqual(['token refreshed']);
});

it('a rotated pair that cannot be written refuses the call and is never presented until written', async () => {
  issuer.answer = rotated;
  let failing = true;
  const held = tokenHolder({
    file,
    tokenUrl: issuer.tokenUrl,
    now: () => clock,
    write: (path, tokens) => {
      if (failing) throw new Error('disk full');
      writeFileSync(path, JSON.stringify(tokens), { mode: 0o600 });
    },
  });
  clock = first.expiresAt;
  expect(await held.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  expect(await held.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  // The spent refresh token is not sent again: the pair held in memory is written next.
  expect(issuer.asked).toHaveLength(1);
  failing = false;
  expect(await held.current()).toEqual({
    ok: true,
    accessToken: 'access-after-refresh-one-xxxxxxxx',
  });
  expect((JSON.parse(readFileSync(file, 'utf8')) as PlanTokens).refreshToken).toBe(
    'rotated-refresh-one-xxxxxxxx',
  );
});

it('a newer pair written during the refresh wait wins over the refresh answer', async () => {
  issuer.answer = (form) => {
    // The owner signs in again while the refresh is in flight.
    writeFileSync(
      file,
      JSON.stringify({
        ...first,
        accessToken: 'access-new-sign-in-xxxx',
        refreshToken: 'refresh-new-sign-in-xxxx',
        expiresAt: clock + 2 * HOUR,
      }),
      { mode: 0o600 },
    );
    return rotated(form);
  };
  const held = holder();
  clock = first.expiresAt;
  expect(await held.current()).toEqual({ ok: true, accessToken: 'access-new-sign-in-xxxx' });
  expect((JSON.parse(readFileSync(file, 'utf8')) as PlanTokens).refreshToken).toBe(
    'refresh-new-sign-in-xxxx',
  );
});

it('a refused refresh does not stop a sign-in that landed during it', async () => {
  issuer.answer = () => {
    writeFileSync(
      file,
      JSON.stringify({
        ...first,
        refreshToken: 'refresh-new-sign-in-xxxx',
        expiresAt: clock + HOUR,
      }),
      { mode: 0o600 },
    );
    return { status: 400, body: { error: 'invalid_grant' } };
  };
  clock = first.expiresAt;
  expect(await holder().current()).toEqual({ ok: true, accessToken: first.accessToken });
});

it('a pair rotated by another process meanwhile is used and nothing is asked', async () => {
  const held = holder();
  clock = first.expiresAt - REFRESH_AHEAD_MS - 1;
  await held.current();
  writeFileSync(
    file,
    JSON.stringify({
      ...first,
      accessToken: 'access-other-xxxxxxxx',
      refreshToken: 'refresh-other-xxxxxxxx',
      expiresAt: clock + 2 * HOUR,
    }),
    { mode: 0o600 },
  );
  clock = first.expiresAt;
  expect(await held.current()).toEqual({ ok: true, accessToken: 'access-other-xxxxxxxx' });
  expect(issuer.asked).toHaveLength(0);
});
