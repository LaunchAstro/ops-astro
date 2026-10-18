// SPDX-License-Identifier: AGPL-3.0-only
//
// The production composition builds its plan token holder only on
// `https://auth.openai.com` (#1704), and refuses anything else at start with
// a typed refusal that writes, locks and fetches nothing. Tests keep their
// loopback issuer through `tokenHolder`, which refuses at build any other
// URL, so no pending is ever committed for a request it may not send.

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { productionTokenHolder } from '../../packages/core-custody/src/plan-token-production.ts';
import { tokenHolder, type PlanLogKind } from '../../packages/core-custody/src/plan-token.ts';
import { refreshOnce } from '../../packages/core-custody/src/token-refresh.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  committedHex,
  fileBytes,
  seed,
  tempDir,
  tokens,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(async () => {
  await issuer.close();
});

/** A token file whose pair is due, so any holder that may refresh would commit `pending`. */
async function due(): Promise<{
  readonly file: string;
  readonly unchanged: () => void;
  readonly done: () => void;
}> {
  const w = tempDir();
  await seed(w.file, { state: 'ready', tokens: tokens('due', T0 + 240_000) });
  const bytes = fileBytes(w.file);
  const digest = committedHex(w.file);
  const names = readdirSync(w.dir).toSorted();
  return {
    file: w.file,
    unchanged: () => {
      expect(fileBytes(w.file).equals(bytes)).toBe(true);
      expect(committedHex(w.file)).toBe(digest);
      expect(readdirSync(w.dir).toSorted()).toEqual(names);
    },
    done: w.done,
  };
}

// The loopback issuer's port stands in for a live listener; nothing may reach it.
const refusedAtStart = [
  'http://127.0.0.1:{port}/token',
  'https://127.0.0.1:{port}/token',
  'http://auth.openai.com/oauth/token',
  'https://auth.openai.com:8443/oauth/token',
  'https://auth.openai.com.example/oauth/token',
  'https://{credentials}auth.openai.com/oauth/token',
  'https://auth.example/oauth/token',
];
/** `{credentials}` adds a synthetic username and password through the URL API. */
const at = (href: string): URL => {
  const url = new URL(href.replace('{port}', issuer.url.port).replace('{credentials}', ''));
  if (href.includes('{credentials}')) {
    url.username = 'synthetic-user';
    url.password = 'synthetic-pass';
  }
  return url;
};

it.each(refusedAtStart)(
  'the production holder refuses %s at start, and writes and fetches nothing',
  async (href) => {
    const before = issuer.count();
    const w = await due();
    const logs: PlanLogKind[] = [];
    try {
      const built = productionTokenHolder({
        file: w.file,
        tokenUrl: at(href),
        now: () => T0,
        log: (kind) => logs.push(kind),
      });
      expect(built).toEqual({ ok: false, code: 'SUBSCRIPTION_ISSUER_REFUSED' });
      w.unchanged();
      expect(logs).toEqual([]);
      expect(issuer.count() - before).toBe(0);
    } finally {
      w.done();
    }
  },
);

it('the production holder is built on the plan issuer and serves a live pair from its file', async () => {
  const w = tempDir();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('live', T0 + 2 * HOUR) });
    const built = productionTokenHolder({
      file: w.file,
      tokenUrl: new URL('https://auth.openai.com/oauth/token'),
      now: () => T0,
    });
    if (!built.ok) throw new Error(`refused: ${built.code}`);
    expect(await built.holder.prepare()).toEqual({ ok: true });
    expect(built.holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-live' });
  } finally {
    w.done();
  }
});

const neverCalled = [
  'http://localhost:{port}/token',
  'https://localhost:{port}/token',
  'http://127.0.0.2:{port}/token',
  'http://{credentials}127.0.0.1:{port}/token',
  'https://auth.example/oauth/token',
];

it.each(neverCalled)('a test holder refuses %s at build, before any pending', async (href) => {
  const before = issuer.count();
  const w = await due();
  try {
    // The whole message: neither the URL nor any credential in it is echoed.
    expect(() => tokenHolder({ file: w.file, tokenUrl: at(href), now: () => T0 })).toThrow(
      /^the token URL is not the plan issuer or a 127\.0\.0\.1 test issuer$/u,
    );
    w.unchanged();
    expect(issuer.count() - before).toBe(0);
  } finally {
    w.done();
  }
});

it('a test holder is still built on its 127.0.0.1 issuer', async () => {
  const w = await due();
  try {
    expect(() => tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => T0 })).not.toThrow();
  } finally {
    w.done();
  }
});

it('one refresh request to an https host other than the plan issuer opens no socket', async () => {
  let sockets = 0;
  const counted = (): void => {
    sockets += 1;
  };
  subscribe('net.client.socket', counted);
  try {
    const out = await refreshOnce(
      new URL(`https://localhost:${issuer.url.port}/token`),
      tokens('elsewhere', T0),
      () => new AbortController().signal,
      () => T0,
    );
    expect(out).toEqual({ result: { kind: 'not_sent' }, sentAt: undefined });
  } finally {
    unsubscribe('net.client.socket', counted);
  }
  expect(sockets).toBe(0);
});

it('a test holder keeps the issuer it was built on when its caller edits the URL afterwards', async () => {
  const other = await startIssuer();
  const w = await due();
  try {
    issuer.set({ kind: 'json', status: 400, body: {} });
    const before = issuer.count();
    const url = new URL(issuer.url.href);
    const holder = tokenHolder({ file: w.file, tokenUrl: url, now: () => T0 });
    url.href = other.url.href;
    await holder.prepare();
    expect(other.count()).toBe(0);
    expect(issuer.count() - before).toBe(1);
  } finally {
    await other.close();
    w.done();
  }
});
