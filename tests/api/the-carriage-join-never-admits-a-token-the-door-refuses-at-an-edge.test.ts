// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one database, the edges asked of one door and one join */
//
// The door (the sign-in adapter on a signed token, then login resolution's
// `standingOf` in the token's business) and the carriage join
// (`ops_carry_may_join`) asked about the same claims text, at the edges the
// two read differently: the door's clock is this process's in whole seconds
// and the join's is the database's; the door reads `amr` through JSON.parse
// and `String(method)`, the join through jsonb. Wherever the two differ, the
// join must be the stricter: it never admits a token the door refuses.

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { callTopic, carriageBusiness, mayJoin, type CarriageBusiness } from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ISSUER = 'http://127.0.0.1:54391/carriage-join-edges';
const KID = `carriage-join-edges-${randomUUID()}`;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicJwk = publicKey.export({ format: 'jwk' });
const KEY_SET = {
  keys: [
    {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x,
      y: publicJwk.y,
      alg: 'ES256',
      kid: KID,
      use: 'sig',
      key_ops: ['verify'],
    },
  ],
};

/** The adapter, its clock `now` when given (whole seconds), this process's otherwise. */
const verifierAt = (now?: () => number) =>
  createSupabaseVerifier({
    issuer: ISSUER,
    keySetUrl: 'https://carriage-join-edges.example.test/auth/v1/.well-known/jwks.json',
    fetch: async () =>
      await Promise.resolve(
        new Response(JSON.stringify(KEY_SET), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ...(now === undefined ? {} : { now }),
  });

/** An ES256 token over exactly this payload text: numbers stay as written. */
function tokenOver(payload: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID })).toString(
    'base64url',
  );
  const body = Buffer.from(payload).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${body}.${signature}`;
}

const requestWith = (token: string) =>
  ({
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
  }) as unknown as Parameters<ReturnType<typeof verifierAt>>[0];

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The claims text, `aal` and `amr` written verbatim. */
function claimsText(sub: string, sessionId: string, aal: string, amr: string): string {
  const now = nowSeconds();
  const base = JSON.stringify({
    sub,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    session_id: sessionId,
    iat: now,
    exp: now + 600,
  });
  return `${base.slice(0, -1)},"aal":${aal},"amr":${amr}}`;
}

const entry = (method: string, stamp: number | string): string =>
  `{"method":${method},"timestamp":${String(stamp)}}`;

/** Wherever the two differ, the join is the stricter. */
const neverLooser = (answers: { door: boolean; join: boolean }, label: string): void => {
  if (!answers.door) {
    expect(answers.join, `${label}: the door refuses it and the join admits it`).toBe(false);
  }
};

describe.skipIf(serverUrl === undefined)(
  'the carriage join never admits a token the door refuses',
  () => {
    let db: FreshDatabase;
    let plain: CarriageBusiness;
    let factored: CarriageBusiness;
    let twin: CarriageBusiness;

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'carriage_join_edges' });
      plain = await carriageBusiness(db.app, 'edgeplain');
      factored = await carriageBusiness(db.app, 'edgefactor');
      twin = await carriageBusiness(db.app, 'edgetwin', { owner: factored.owner.sub });
      // The factored owner's login verified a factor, in this business only.
      await db.app.withBusiness(factored.id, async (tx) => {
        const factor = await recordFactorEnrolled(tx, {
          personId: factored.owner.person,
          provider: 'supabase',
          providerFactorId: randomUUID(),
        });
        await recordFactorVerified(tx, {
          personId: factored.owner.person,
          factorId: factor.id,
          subject: factored.owner.sub,
        });
      });
    }, 180_000);

    afterAll(async () => await db?.drop());

    /** The join first, then the door, on the same claims text, for `on`'s owner on its call. */
    async function ask(
      on: CarriageBusiness,
      claims: string,
      now?: () => number,
    ): Promise<{ readonly door: boolean; readonly join: boolean }> {
      const join = await mayJoin(db.admin, callTopic(on.id, on.callId), claims);
      const verified = await verifierAt(now)(requestWith(tokenOver(claims)));
      if (typeof verified !== 'object') return { door: false, join };
      const standing = await db.app.withBusiness(on.id, (tx) =>
        standingOf(tx, verified, 'required'),
      );
      return { door: 'actorId' in standing, join };
    }

    it('control: a fresh password sign-in is admitted by both', async () => {
      const now = nowSeconds();
      const claims = claimsText(
        plain.owner.sub,
        randomUUID(),
        '"aal1"',
        `[${entry('"password"', now)}]`,
      );
      expect(await ask(plain, claims)).toEqual({ door: true, join: true });
    });

    it('the 12 hours and the minute ahead, the door on the database clock: the join never the looser', async () => {
      for (const [label, offset] of [
        ['exactly 12 h', -43_200],
        ['12 h and a second', -43_201],
        ['60 s ahead', 60],
        ['61 s ahead', 61],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time, each on a fresh clock read
        const [row] = await db.admin.execute<{ readonly at: number }>(
          'select floor(extract(epoch from clock_timestamp()))::float8 as at',
        );
        const at = Number(row?.at);
        const claims = claimsText(
          plain.owner.sub,
          randomUUID(),
          '"aal1"',
          `[${entry('"password"', at + offset)}]`,
        );
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        neverLooser(await ask(plain, claims, () => at), label);
      }
    });

    it('a first sign-in 13 hours ago written past double precision, with a later one: refused by both', async () => {
      const now = nowSeconds();
      const old = now - 13 * 3600;
      const amr = `[${entry('"password"', `${String(old)}.000000000000000001`)},${entry('"password"', now)}]`;
      const answers = await ask(plain, claimsText(plain.owner.sub, randomUUID(), '"aal1"', amr));
      expect(answers.door, 'the door reads the earliest sign-in as 13 hours ago').toBe(false);
      neverLooser(answers, 'a first sign-in past double precision');
    });

    it('a first sign-in 13 hours ago whose method is a one-item list, with a later one: refused by both', async () => {
      const now = nowSeconds();
      const old = now - 13 * 3600;
      const amr = `[${entry('["password"]', old)},${entry('"password"', now)}]`;
      const answers = await ask(plain, claimsText(plain.owner.sub, randomUUID(), '"aal1"', amr));
      expect(answers.door, 'the door reads the earliest sign-in as 13 hours ago').toBe(false);
      neverLooser(answers, 'a first sign-in method as a list');
    });

    it('a sign-in whose method reads as no first factor (a number, an object, a two-item list) begins no session at either', async () => {
      const now = nowSeconds();
      for (const method of ['5', '{"name":"password"}', '["password","otp"]', '[]', 'null']) {
        const amr = `[${entry(method, now)}]`;
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(plain, claimsText(plain.owner.sub, randomUUID(), '"aal1"', amr));
        expect(answers.door, `the door finds no first sign-in in ${method}`).toBe(false);
        neverLooser(answers, `a sign-in method ${method}`);
      }
    });

    it('a sign-in time too small or too large to read, beside a fresh sign-in, reads alike at both', async () => {
      const now = nowSeconds();
      for (const stamp of ['1e-400', '0.4', '1e400', '-1']) {
        const amr = `[${entry('"password"', stamp)},${entry('"password"', now)}]`;
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(plain, claimsText(plain.owner.sub, randomUUID(), '"aal1"', amr));
        expect(answers, `a sign-in time ${stamp}`).toEqual({ door: true, join: true });
      }
    });

    it('scale written on a sign-in time (.0, e-1) reads alike at both', async () => {
      const now = nowSeconds();
      for (const [label, written] of [
        ['.0', `${String(now)}.0`],
        ['e-1', `${String(now)}0e-1`],
        ['e+0', `${String(now)}e+0`],
      ] as const) {
        const claims = claimsText(
          plain.owner.sub,
          randomUUID(),
          '"aal1"',
          `[${entry('"password"', written)}]`,
        );
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        expect(await ask(plain, claims), label).toEqual({ door: true, join: true });
      }
    });

    it('an earlier entry that is not a first factor does not move the sign-in, at either', async () => {
      const now = nowSeconds();
      const old = now - 13 * 3600;
      for (const method of [
        '"totp"',
        '"mfa/webauthn"',
        '"anonymous"',
        '"PASSWORD"',
        '"token_refresh"',
      ]) {
        const amr = `[${entry(method, old)},${entry('"password"', now)},${entry('"totp"', now)}]`;
        const claims = claimsText(factored.owner.sub, randomUUID(), '"aal2"', amr);
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        expect(await ask(factored, claims), method).toEqual({ door: true, join: true });
      }
    });

    it('aal2 claimed with no usable second factor: refused for a login with a factor, by both', async () => {
      const now = nowSeconds();
      const shapes: readonly [string, string][] = [
        ['no totp entry', `[${entry('"password"', now)}]`],
        ['totp at zero', `[${entry('"password"', now)},${entry('"totp"', 0)}]`],
        [
          'totp a string time',
          `[${entry('"password"', now)},${entry('"totp"', `"${String(now)}"`)}]`,
        ],
        ['totp a fraction', `[${entry('"password"', now)},${entry('"totp"', `${String(now)}.5`)}]`],
        ['aal2 in capitals', `[${entry('"password"', now)},${entry('"totp"', now)}]`],
      ];
      for (const [label, amr] of shapes) {
        const aal = label === 'aal2 in capitals' ? '"AAL2"' : '"aal2"';
        const claims = claimsText(factored.owner.sub, randomUUID(), aal, amr);
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        expect(await ask(factored, claims), label).toEqual({ door: false, join: false });
      }
      // The control: the factor given is admitted by both.
      const given = claimsText(
        factored.owner.sub,
        randomUUID(),
        '"aal2"',
        `[${entry('"password"', now)},${entry('"totp"', now)}]`,
      );
      expect(await ask(factored, given)).toEqual({ door: true, join: true });
    });

    it('a second factor whose method is a one-item list: the join no looser than the door', async () => {
      const now = nowSeconds();
      const amr = `[${entry('"password"', now)},${entry('["totp"]', now)}]`;
      neverLooser(
        await ask(factored, claimsText(factored.owner.sub, randomUUID(), '"aal2"', amr)),
        'a second factor method as a list',
      );
    });

    it('a signed-out session named in capitals is refused by both; in braces it names no session at either', async () => {
      const now = nowSeconds();
      const out = randomUUID();
      await db.app.withBusiness(plain.id, async (tx) => await endProviderSession(tx, out));
      const amr = `[${entry('"password"', now)}]`;
      expect(
        await ask(plain, claimsText(plain.owner.sub, out.toUpperCase(), '"aal1"', amr)),
      ).toEqual({
        door: false,
        join: false,
      });
      expect(await ask(plain, claimsText(plain.owner.sub, `{${out}}`, '"aal1"', amr))).toEqual({
        door: true,
        join: true,
      });
    });

    it('a login in two businesses: a factor verified through one is asked for in the other, by both', async () => {
      const now = nowSeconds();
      const password = claimsText(
        twin.owner.sub,
        randomUUID(),
        '"aal1"',
        `[${entry('"password"', now)}]`,
      );
      expect(await ask(twin, password)).toEqual({ door: false, join: false });
      const given = claimsText(
        twin.owner.sub,
        randomUUID(),
        '"aal2"',
        `[${entry('"password"', now)},${entry('"totp"', now)}]`,
      );
      expect(await ask(twin, given)).toEqual({ door: true, join: true });
    });
  },
);
