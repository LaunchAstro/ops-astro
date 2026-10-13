// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one database, five endings, and the tokens asked of each */
//
// The carriage join (`ops_carry_may_join`) and the API door read the same
// session endings from the same token. For each token below, signed with a key
// this file makes, the door is asked as it serves a request: the sign-in
// adapter reads the token (`createSupabaseVerifier`), and `sessionEnded` asks
// the database about what it read. The join is then asked with the same claims
// text on the same rows. Whenever the door refuses the token, the join must
// refuse it too; for a well-formed token inside the 12 hours the two must give
// the same answer. Each join is asked before the door, because the door ends a
// session it refuses while a reset is open.
//
// Endings, each its own business so one never answers for another, written
// with whole-second times so a stamp can sit exactly on an edge:
//   others    the login's other sessions ended, `ended_before` at E
//   settled   a reset settled at S, a whole second
//   half      a reset settled half a second past S
//   open      a reset still open, `open_until` at O
//   signedout the token's own session signed out
// And one provider user with logins in two businesses, ended in one.

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  endProviderSession,
  sessionEnded,
} from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  callTopic,
  carriageBusiness,
  doorbellTopic,
  mayJoin,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ISSUER = 'http://127.0.0.1:54391/carriage-join-endings';
const KID = `carriage-join-endings-${randomUUID()}`;
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

const verify = createSupabaseVerifier({
  issuer: ISSUER,
  keySetUrl: 'https://carriage-join-endings.example.test/auth/v1/.well-known/jwks.json',
  fetch: async () =>
    await Promise.resolve(
      new Response(JSON.stringify(KEY_SET), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
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
  }) as unknown as Parameters<typeof verify>[0];

/**
 * The claims text: `sub`, `session_id` (left out when `undefined`, written as
 * given otherwise, `null` included) and `amr` written verbatim, so a number
 * keeps the form it is written in.
 */
function claimsText(sub: string, sessionId: unknown, amr?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    sub,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    iat: now,
    exp: now + 600,
  };
  if (sessionId !== undefined) base['session_id'] = sessionId;
  const text = JSON.stringify(base);
  return amr === undefined ? text : `${text.slice(0, -1)},"amr":${amr}}`;
}

const password = (stamp: number | string): string =>
  `[{"method":"password","timestamp":${String(stamp)}}]`;

interface Answers {
  /** The door refused: the adapter did not serve the token, or `sessionEnded` said ended. */
  readonly doorRefuses: boolean;
  /** The adapter served it (a first sign-in it could read, inside the 12 hours). */
  readonly served: boolean;
  readonly joins: boolean;
}

/** The SQL digest of a provider subject, as the endings store it. */
const digest = (sub: string) => `encode(sha256(convert_to('${sub}', 'UTF8')), 'hex')`;

/** What the door refuses the join refuses; a served well-formed token gets one answer from both. */
function agree(answers: Answers, wellFormed: boolean, label: string): void {
  if (answers.doorRefuses) {
    expect(answers.joins, `${label}: the door refuses this token and the join admits it`).toBe(
      false,
    );
  }
  if (wellFormed) {
    expect(answers.served, `${label}: the door does not serve this well-formed token`).toBe(true);
    expect(answers.joins, `${label}: the join and the door disagree`).toBe(!answers.doorRefuses);
  }
}

describe.skipIf(serverUrl === undefined)(
  'the carriage join reads an ending as the door does',
  () => {
    let db: FreshDatabase;
    /** Whole seconds, a little in the past, so every stamp near them is inside the 12 hours. */
    let E: number;
    let S: number;
    let O: number;
    const worlds: Record<string, CarriageBusiness> = {};
    let elsewhere: CarriageBusiness;
    const signedOut = randomUUID();

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'carriage_join_endings' });
      for (const name of ['others', 'settled', 'half', 'open', 'signedout', 'none']) {
        // oxlint-disable-next-line no-await-in-loop -- one business at a time
        worlds[name] = await carriageBusiness(db.app, name);
      }
      elsewhere = await carriageBusiness(db.app, 'elsewhere', {
        owner: worlds['others']?.owner.sub ?? '',
      });
      const now = Math.floor(Date.now() / 1000);
      E = now - 3600;
      S = now - 3000;
      O = now - 100;
      const sub = (name: string) => worlds[name]?.owner.sub ?? '';
      await db.admin.execute(
        `insert into ops.ended_subject_sessions (subject_digest, kept_session, ended_before)
       values (${digest(sub('others'))}, null, to_timestamp($1))`,
        [E],
      );
      // The ending's time is set to its commit; put it back on the whole second E.
      await db.admin.execute(
        `update ops.ended_subject_sessions set ended_before = to_timestamp($1)
        where subject_digest = ${digest(sub('others'))}`,
        [E],
      );
      await db.admin.execute(
        `insert into ops.subject_resets (id, subject_digest, open_until, settled_at) values
         (gen_random_uuid(), ${digest(sub('settled'))}, to_timestamp($1 + 300), to_timestamp($1)),
         (gen_random_uuid(), ${digest(sub('half'))}, to_timestamp($1 + 300), to_timestamp($1 + 0.5)),
         (gen_random_uuid(), ${digest(sub('open'))}, to_timestamp($2), null)`,
        [S, O],
      );
      const signedOutWorld = worlds['signedout'];
      if (signedOutWorld === undefined) throw new Error('no signed-out business');
      await db.app.withBusiness(
        signedOutWorld.id,
        async (tx) => await endProviderSession(tx, signedOut),
      );
    }, 180_000);

    afterAll(async () => await db?.drop());

    const world = (name: string): CarriageBusiness => {
      const found = worlds[name];
      if (found === undefined) throw new Error(`no business ${name}`);
      return found;
    };

    /** The join first, then the door, on the same rows, for `world`'s owner on its call topic. */
    async function ask(
      on: CarriageBusiness,
      claims: string,
      topic = callTopic(on.id, on.callId),
    ): Promise<Answers> {
      const joins = await mayJoin(db.admin, topic, claims);
      const verified = await verify(requestWith(tokenOver(claims)));
      if (typeof verified !== 'object') return { doorRefuses: true, served: false, joins };
      const presented: VerifiedSubject = verified;
      const ended = await db.app.withBusiness(
        on.id,
        async (tx) => await sessionEnded(tx, presented),
      );
      return { doorRefuses: ended, served: true, joins };
    }

    it('control: each owner joins its own call topic with a fresh session signed in now', async () => {
      for (const name of Object.keys(worlds)) {
        const now = Math.floor(Date.now() / 1000);
        // oxlint-disable-next-line no-await-in-loop -- one business at a time
        const answers = await ask(
          world(name),
          claimsText(world(name).owner.sub, randomUUID(), password(now)),
        );
        expect(answers, name).toEqual({ doorRefuses: false, served: true, joins: true });
      }
    });

    it('other sessions ended at E: a first sign-in at E + 60 s is ended, at E + 61 s served, each the same at the join', async () => {
      const on = world('others');
      const cases: readonly [string, number, boolean][] = [
        ['E - 1', E - 1, true],
        ['E', E, true],
        ['E + 60 (the edge)', E + 60, true],
        ['E + 61', E + 61, false],
      ];
      for (const [label, stamp, ended] of cases) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(on, claimsText(on.owner.sub, randomUUID(), password(stamp)));
        agree(answers, true, label);
        expect(answers.doorRefuses, label).toBe(ended);
      }
    });

    it('a reset settled at a whole second S: a stamp of S - 1 is ended, a stamp of S served, at the join as at the door', async () => {
      const settled = world('settled');
      const half = world('half');
      const cases: readonly [CarriageBusiness, string, number, boolean][] = [
        [settled, 'settled at S, signed S - 1', S - 1, true],
        [settled, 'settled at S, signed S', S, false],
        [settled, 'settled at S, signed S - 60', S - 60, true],
        [half, 'settled at S + 0.5, signed S - 1', S - 1, true],
        [half, 'settled at S + 0.5, signed S', S, false],
        [half, 'settled at S + 0.5, signed S + 1', S + 1, false],
      ];
      for (const [on, label, stamp, ended] of cases) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(on, claimsText(on.owner.sub, randomUUID(), password(stamp)));
        agree(answers, true, label);
        expect(answers.doorRefuses, label).toBe(ended);
      }
    });

    it('a reset still open until O: a stamp at O is ended, at O + 1 served, at the join as at the door', async () => {
      const on = world('open');
      const cases: readonly [string, number, boolean][] = [
        ['O - 30', O - 30, true],
        ['O (the edge)', O, true],
        ['O + 1', O + 1, false],
      ];
      for (const [label, stamp, ended] of cases) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(on, claimsText(on.owner.sub, randomUUID(), password(stamp)));
        agree(answers, true, label);
        expect(answers.doorRefuses, label).toBe(ended);
      }
    });

    // The session signed in with its password an hour and ten minutes ago,
    // before the ending; its second factor came after it. The door reads the
    // password's time, a whole number however the JSON writes it: ended.
    it.each([
      ['written plain', String],
      ['written with an exponent', (at: number) => `${String(at / 100)}e2`],
      ['written with a trailing .0', (at: number) => `${String(at)}.0`],
      ['written with a negative exponent', (at: number) => `${String(at)}0e-1`],
    ] as const)(
      'a password sign-in before the ending, %s, with a second factor after it: ended at the door and at the join',
      async (_label, written) => {
        const on = world('others');
        const after = Math.floor(Date.now() / 1000) - 5;
        const amr = `[{"method":"password","timestamp":${written(E - 600)}},{"method":"totp","timestamp":${String(after)}}]`;
        const answers = await ask(on, claimsText(on.owner.sub, randomUUID(), amr));
        expect(answers.served).toBe(true);
        expect(answers.doorRefuses, "the door reads the password's time").toBe(true);
        expect(answers.joins, 'a session the door ends joins a carriage topic').toBe(false);
      },
    );

    it('a first sign-in the door cannot read is refused at the door, and the join refuses it under every ending', async () => {
      const unreadable: readonly [string, string][] = [
        ['zero', password(0)],
        ['negative', password(-(E - 600))],
        ['a fraction', password(`${String(E - 600)}.5`)],
        ['a string', password(`"${String(E - 600)}"`)],
        ['twelve digits', password(100_000_000_000)],
        ['far future', password(99_999_999_999)],
        ['amr an object', `{"0":{"method":"password","timestamp":${String(E - 600)}}}`],
        ['amr entries not objects', `[${String(E - 600)},"password",null,[1]]`],
        ['amr null', 'null'],
        ['no amr', ''],
      ];
      for (const name of ['others', 'settled', 'open']) {
        const on = world(name);
        for (const [label, amr] of unreadable) {
          const claims = claimsText(on.owner.sub, randomUUID(), amr === '' ? undefined : amr);
          // oxlint-disable-next-line no-await-in-loop -- one token at a time
          const answers = await ask(on, claims);
          expect(answers.doorRefuses, `${name}, ${label}`).toBe(true);
          if (label !== 'far future') {
            expect(answers.joins, `${name}, ${label}: the join admits an unreadable sign-in`).toBe(
              false,
            );
          }
        }
      }
    });

    it("the token's own session signed out: refused in any spelling of its id the door reads", async () => {
      const on = world('signedout');
      const now = Math.floor(Date.now() / 1000);
      const spellings: readonly [string, unknown][] = [
        ['lower case', signedOut],
        ['upper case', signedOut.toUpperCase()],
      ];
      for (const [label, id] of spellings) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(on, claimsText(on.owner.sub, id, password(now)));
        agree(answers, true, label);
        expect(answers.doorRefuses, label).toBe(true);
      }
      // A spelling the door reads as no session at all: the join refuses or
      // admits it, never errors; one it reads as no session is admitted by both.
      const unread: readonly [string, unknown][] = [
        ['braces', `{${signedOut}}`],
        ['no hyphens', signedOut.replaceAll('-', '')],
        ['not a uuid', 'not-a-session'],
        ['empty', ''],
        ['null', null],
        ['a number', 7],
        ['missing', undefined],
      ];
      for (const [label, id] of unread) {
        // oxlint-disable-next-line no-await-in-loop -- one token at a time
        const answers = await ask(on, claimsText(on.owner.sub, id, password(now)));
        expect(answers, label).toMatchObject({ served: true, doorRefuses: false });
      }
    });

    it("one provider user's other sessions ended: refused in both businesses its logins reach; another subject is not", async () => {
      const on = world('others');
      const now = Math.floor(Date.now() / 1000);
      const before = E - 120;
      const here = await ask(on, claimsText(on.owner.sub, randomUUID(), password(before)));
      const there = await ask(elsewhere, claimsText(on.owner.sub, randomUUID(), password(before)));
      expect(here).toEqual({ doorRefuses: true, served: true, joins: false });
      expect(there).toEqual({ doorRefuses: true, served: true, joins: false });
      // Another subject in the same business, signed in before the ending, is not this ending's.
      const agent = await ask(
        on,
        claimsText(on.agent.sub, randomUUID(), password(before)),
        doorbellTopic(on.id, on.agent.actor),
      );
      expect(agent.joins).toBe(true);
      // A later sign-in of the same user joins in both.
      const later = await ask(elsewhere, claimsText(on.owner.sub, randomUUID(), password(now)));
      expect(later).toEqual({ doorRefuses: false, served: true, joins: true });
    });

    it('a session signed out in one business is refused in the other its login reaches', async () => {
      const shared = randomUUID();
      const on = world('none');
      const twin = await carriageBusiness(db.app, 'twin', { owner: on.owner.sub });
      const now = Math.floor(Date.now() / 1000);
      const claims = claimsText(on.owner.sub, shared, password(now));
      expect(await ask(twin, claims)).toEqual({ doorRefuses: false, served: true, joins: true });
      await db.app.withBusiness(on.id, async (tx) => await endProviderSession(tx, shared));
      expect(await ask(twin, claims)).toEqual({ doorRefuses: true, served: true, joins: false });
      expect(await ask(on, claims)).toEqual({ doorRefuses: true, served: true, joins: false });
      // The same user's other session, in either business, is not this ending's.
      const other = claimsText(on.owner.sub, randomUUID(), password(now));
      expect(await ask(twin, other)).toEqual({ doorRefuses: false, served: true, joins: true });
    });
    it('claims of any shape are answered, never raised, under every ending', async () => {
      for (const name of ['others', 'settled', 'open', 'signedout']) {
        const on = world(name);
        const sid = name === 'signedout' ? signedOut : randomUUID();
        const odd: readonly string[] = [
          '"a string"',
          '[1, 2]',
          '7',
          'null',
          `{"sub":{"a":1},"session_id":"${sid}"}`,
          `{"sub":"${on.owner.sub}","session_id":["${sid}"]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":[{"timestamp":{"t":1}}]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":[{"timestamp":1e400}]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":[{"timestamp":-0}]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":[{"timestamp":99999999999}]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":[{"timestamp":true}]}`,
          `{"sub":"${on.owner.sub}","session_id":"${sid}","amr":"password"}`,
        ];
        for (const claims of odd) {
          // oxlint-disable-next-line no-await-in-loop -- one claims text at a time
          await expect(
            mayJoin(db.admin, callTopic(on.id, on.callId), claims),
            `${name} ${claims}`,
          ).resolves.toBeTypeOf('boolean');
        }
      }
    });
  },
);
