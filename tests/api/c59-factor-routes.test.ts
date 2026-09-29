// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a person's own second factor through the real API, against a stand-in
// sign-in provider on a loopback port.
//
// The provider is the one thing not real here, and it is stood in for at the
// network, not in code: `auth/factors.ts` makes its real calls over HTTP to a
// server this file controls, so every hostile answer (malformed, oversized,
// slow, the wrong shape, a redirect, a server error) reaches the adapter the
// way GoTrue's would. The shared local GoTrue is never reconfigured for this.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from 'hono/jwt';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  ACCEPTANCE_ISSUER,
  ACCEPTANCE_SECRET,
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';

const CANARY = 'CANARY-c59-totp-secret-7f3a9e';

const now = () => Math.floor(Date.now() / 1000);

const GOOD_TOTP = { qr_code: 'data:,x', secret: 'S', uri: 'otpauth://totp/x' };
const GOOD_ENROL = { id: 'factor-one', type: 'totp', totp: GOOD_TOTP };

/** What the stand-in provider does next, per path. */
type Reply = (request: IncomingMessage, response: ServerResponse, body: string) => void;

const json =
  (status: number, value: unknown): Reply =>
  (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

const GOOD: Readonly<Record<string, Reply>> = {
  'POST /factors': json(200, {
    id: 'factor-one',
    type: 'totp',
    totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: CANARY, uri: 'otpauth://totp/x' },
  }),
  'POST /factors/factor-one/challenge': json(200, { id: 'challenge-one', type: 'totp' }),
  'POST /factors/factor-one/verify': json(200, {
    access_token: 'aal2-access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
  }),
  'DELETE /factors/factor-one': json(200, { id: 'factor-one' }),
  // C58: a factor change ends the person's other sessions at the provider.
  'POST /logout?scope=others': (_request, response) => {
    response.writeHead(204);
    response.end();
  },
};

interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    let world: World;
    let provider: Server;
    let replies: Record<string, Reply> = { ...GOOD };
    let seen: Seen[] = [];
    let api: ReturnType<typeof createApi>;
    let slowApi: ReturnType<typeof createApi>;
    let clientA: Member;
    let clientB: Member;
    /** A third client, whose factor the path and lockout cases use. */
    let clientC: Member;
    /** A fourth client, who enrols from two tabs at once. */
    let clientD: Member;

    /** A bearer carrying the assurance a sign-in gave it, signed as GoTrue signs. */
    const tokenFor = async (
      subject: string,
      assurance: {
        readonly aal: 'aal1' | 'aal2';
        readonly password: number;
        readonly totp?: number;
      },
    ) =>
      await sign(
        {
          sub: subject,
          aud: 'authenticated',
          iss: ACCEPTANCE_ISSUER,
          exp: now() + 600,
          aal: assurance.aal,
          amr: [
            { method: 'password', timestamp: assurance.password },
            ...(assurance.totp === undefined
              ? []
              : [{ method: 'totp', timestamp: assurance.totp }]),
          ],
        },
        ACCEPTANCE_SECRET,
        'HS256',
      );

    const fresh = async (caller: { readonly subject: string } | Member) =>
      await tokenFor(subjectOf(caller), { aal: 'aal1', password: now() - 60 });

    const act = async (
      name: 'enrol' | 'verify' | 'remove',
      token: string,
      body: unknown = {},
      via?: ReturnType<typeof createApi>,
    ) =>
      await call(via ?? api, personPath('alpha', `/account/factor/${name}`), body, bearer(token));

    const factorOf = async (personId: string | null) =>
      await world.db.app.withBusiness(
        world.alpha,
        async (tx) => await liveFactor(tx, personId ?? ''),
      );

    const eventsFor = async (command: string) =>
      await world.db.app.withBusiness(world.alpha, async (tx) =>
        tx.query<{ readonly outcome: string; readonly refusal_code: string | null }>(
          `select outcome, refusal_code from public.audit_events
          where command = $1 order by seq`,
          [command],
        ),
      );

    const build = (timeoutMs?: number, basePath = '', database: Database = world.db.app) =>
      createApi({
        database,
        verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET, issuer: ACCEPTANCE_ISSUER }),
        resolveBusiness: async (key: string) => ({ alpha: world.alpha, bravo: world.bravo })[key],
        executeCommand,
        executeRead,
        executeAgentCommand,
        factors: createGoTrueFactors({
          baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}${basePath}`,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      });

    beforeAll(async () => {
      world = await createWorld('c59r');
      provider = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        request.on('end', () => {
          const route = `${request.method} ${request.url}`;
          seen.push({ route, authorization: request.headers.authorization, body });
          // A Map lookup: the request line names no prototype member (CodeQL js/unvalidated-dynamic-method-call).
          const reply =
            new Map(Object.entries(replies)).get(route) ??
            json(404, { code: 404, msg: 'no such route' });
          reply(request, response, body);
        });
      });
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
      api = build();
      slowApi = build(200);

      // Two clients of alpha, each standing on one task shared with them.
      const tasks: string[] = [];
      for (const title of ['client A work', 'client B work']) {
        // oxlint-disable-next-line no-await-in-loop
        const created = await executeCommand(
          world.db.app,
          world.alpha,
          world.ada.presented,
          'api',
          {
            command: 'task.create',
            operationId: `c59-${randomUUID()}`,
            fields: { title },
          },
        );
        if (isCommandRefusal(created) || created.recordId === null) {
          throw new Error('task.create did not create the fixture task');
        }
        tasks.push(created.recordId);
      }
      const sharer = world.ada as unknown as Member;
      clientA = await shareWithClient(world.db.app, world.alpha, sharer, tasks[0] ?? '');
      clientB = await shareWithClient(world.db.app, world.alpha, sharer, tasks[1] ?? '');
      clientC = await shareWithClient(world.db.app, world.alpha, sharer, tasks[1] ?? '');
      clientD = await shareWithClient(world.db.app, world.alpha, sharer, tasks[0] ?? '');
    }, 60_000);

    afterEach(() => {
      replies = { ...GOOD };
      seen = [];
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
      await world?.close();
    });

    it('C59 first enrolment: a stale password sign-in is refused and the provider is never asked', async () => {
      const stale = await tokenFor(world.mia.subject, { aal: 'aal1', password: now() - 3601 });
      const answer = await act('enrol', stale);
      expect(answer.status).toBe(403);
      expect(answer.code).toBe('FRESH_SIGN_IN_REQUIRED');
      expect(seen).toEqual([]);
      expect(await factorOf(world.mia.personId)).toBeUndefined();
      expect((await eventsFor('account.factor_enrol')).at(-1)).toEqual({
        outcome: 'refused',
        refusal_code: 'FRESH_SIGN_IN_REQUIRED',
      });
    });

    it('C59 first enrolment: a fresh password sign-in with no factor enrols, and the first code completes it', async () => {
      const token = await fresh(world.mia);
      const enrolled = await act('enrol', token);
      expect(enrolled.status).toBe(200);
      expect(enrolled.body).toMatchObject({ factorId: 'factor-one', secret: CANARY });
      expect(seen.map((request) => request.route)).toEqual(['POST /factors']);
      expect(seen[0]?.authorization).toBe(`Bearer ${token}`);
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'unverified' });

      // One event for the act, written with its record after the provider
      // answered; the check before the call recorded nothing, having done nothing.
      const enrolEvents = await eventsFor('account.factor_enrol');
      expect(enrolEvents.filter((event) => event.outcome === 'applied')).toHaveLength(1);

      const verified = await act('verify', token, { code: '123456' });
      expect(verified.status).toBe(200);
      expect(verified.body).toMatchObject({ accessToken: 'aal2-access-token' });
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'verified' });
      expect((await eventsFor('account.factor_verify')).at(-1)).toEqual({
        outcome: 'applied',
        refusal_code: null,
      });
    });

    it('C59 first enrolment: a person who already has a verified factor is refused a second one', async () => {
      const answer = await act('enrol', await fresh(world.mia));
      expect(answer.status).toBe(409);
      expect(answer.code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(seen).toEqual([]);
    });

    it('C59 two enrolments at once: both tabs are answered, and one live factor remains', async () => {
      // Both requests pass the check before the provider call, and the provider
      // answers neither until it holds both, so both record steps run together.
      const held: Array<() => void> = [];
      let issued = 0;
      replies['POST /factors'] = (_request, response) => {
        issued += 1;
        const id = `factor-race-${issued}`;
        held.push(() => json(200, { id, type: 'totp', totp: GOOD_TOTP })(_request, response, ''));
        if (held.length === 2) for (const release of held) release();
      };
      // Two connections, as a server with a wider pool has: on one connection
      // the transactions queue and the race cannot happen.
      const wide = connect(world.db.appUrl, { source: 'runtime', max: 2 });
      const token = await fresh(clientD);
      const via = build(undefined, '', wide);
      const [first, second] = await Promise.all([
        act('enrol', token, {}, via),
        act('enrol', token, {}, via),
      ]).finally(async () => await wide.close());

      expect([first.status, second.status]).toEqual([200, 200]);
      const rows = await world.db.app.withBusiness(world.alpha, async (tx) =>
        tx.query<{ readonly provider_factor_id: string; readonly status: string }>(
          `select provider_factor_id, status from public.second_factors
            where person_id = $1 order by enrolled_at, provider_factor_id`,
          [clientD.personId],
        ),
      );
      // The later record replaces the earlier: one live, the other ended.
      expect(rows.map((row) => row.status).toSorted()).toEqual(['removed', 'unverified']);
      expect(new Set(rows.map((row) => row.provider_factor_id))).toEqual(
        new Set(['factor-race-1', 'factor-race-2']),
      );
      expect(await factorOf(clientD.personId)).toMatchObject({ status: 'unverified' });
      const applied = (await eventsFor('account.factor_enrol')).filter(
        (event) => event.outcome === 'applied',
      );
      expect(applied.length).toBeGreaterThanOrEqual(2);
    });

    it('C59 factor change: removing needs the current code, entered for that change', async () => {
      const token = await fresh(world.mia);

      const bare = await act('remove', token, {});
      expect(bare.code).toBe('COMMAND_BODY_INVALID');
      expect(seen).toEqual([]);

      replies['POST /factors/factor-one/verify'] = json(422, {
        code: 422,
        msg: 'Invalid TOTP code',
      });
      const wrong = await act('remove', token, { code: '000000' });
      expect(wrong.status).toBe(422);
      expect(wrong.code).toBe('SECOND_FACTOR_INVALID');
      expect(seen.map((request) => request.route)).not.toContain('DELETE /factors/factor-one');
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'verified' });
      expect((await eventsFor('account.factor_remove')).at(-1)).toEqual({
        outcome: 'refused',
        refusal_code: 'SECOND_FACTOR_INVALID',
      });

      replies = { ...GOOD };
      seen = [];
      const removed = await act('remove', token, { code: '123456' });
      expect(removed.status).toBe(200);
      // The removal is made with the aal2 session the code just gave, not the
      // password-only bearer the request arrived with.
      const deletion = seen.find((request) => request.route === 'DELETE /factors/factor-one');
      expect(deletion?.authorization).toBe('Bearer aal2-access-token');
      expect(await factorOf(world.mia.personId)).toBeUndefined();
      // The person row's mirror follows the factor rows: no verified factor
      // left, so a sign-in without one is enough again.
      const mirrored = await world.db.app.withBusiness(world.alpha, async (tx) =>
        tx.query<{ readonly on: boolean }>(
          'select second_factor_verified as on from public.people where id = $1',
          [world.mia.personId],
        ),
      );
      expect(mirrored[0]?.on).toBe(false);
    });

    const HOSTILE: ReadonlyArray<readonly [string, Reply]> = [
      ['malformed JSON', (_q, response) => response.end('{"id": "factor-one", "totp": ')],
      // A good answer in every field but its size, so only the size limit refuses it.
      ['an oversized answer', json(200, { ...GOOD_ENROL, padding: 'x'.repeat(40_000) })],
      ['the wrong shape', json(200, { id: 'factor-one', totp: { secret: 42 } })],
      ['an id that is not an identifier', json(200, { id: '../admin', totp: GOOD_TOTP })],
      [
        'a redirect elsewhere',
        (_q, response) => {
          response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          response.end();
        },
      ],
      ['a server error carrying the canary', json(500, { msg: `boom ${CANARY}` })],
    ];

    it.each(HOSTILE)(
      'C59 hostile provider: %s during enrolment is refused, recorded, and changes nothing',
      async (_, reply) => {
        replies['POST /factors'] = reply;
        const answer = await act('enrol', await fresh(world.noah));
        expect(answer.status).toBe(502);
        expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
        expect(await factorOf(world.noah.personId)).toBeUndefined();
        expect((await eventsFor('account.factor_enrol')).at(-1)).toEqual({
          outcome: 'refused',
          refusal_code: 'PROVIDER_ANSWER_INVALID',
        });
      },
    );

    it('C59 hostile provider: a slow answer is abandoned at the time limit and refused', async () => {
      replies['POST /factors'] = (_q, response) => {
        setTimeout(() => json(200, GOOD_ENROL)(_q, response, ''), 4000).unref();
      };
      const started = Date.now();
      const answer = await act('enrol', await fresh(world.noah), {}, slowApi);
      // Abandoned long before the answer arrives at 4 s; the margin is for a loaded machine.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
      expect(answer.body['names']).toEqual(['slow']);
      expect(await factorOf(world.noah.personId)).toBeUndefined();
    });

    it('C59 hostile provider: a malformed answer during verification leaves the factor as it was', async () => {
      const token = await fresh(world.noah);
      expect((await act('enrol', token)).status).toBe(200);
      replies['POST /factors/factor-one/verify'] = json(200, { access_token: 7 });
      const answer = await act('verify', token, { code: '123456' });
      expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
      expect(await factorOf(world.noah.personId)).toMatchObject({ status: 'unverified' });
    });

    it('C59 hostile provider: a provider served under a path is called under that path', async () => {
      replies = { 'POST /auth/v1/factors': GOOD['POST /factors'] ?? json(500, {}) };
      const underPath = await act('enrol', await fresh(clientC), {}, build(undefined, '/auth/v1/'));
      expect(underPath.status).toBe(200);
      expect(seen.map((request) => request.route)).toEqual(['POST /auth/v1/factors']);
    });

    it('C59 factor change: five wrong codes in fifteen minutes stop the provider being asked', async () => {
      const token = await fresh(clientC);
      expect((await act('verify', token, { code: '123456' })).status).toBe(200);
      replies['POST /factors/factor-one/verify'] = json(422, {
        code: 422,
        msg: 'Invalid TOTP code',
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop
        expect((await act('verify', token, { code: '000000' })).code).toBe('SECOND_FACTOR_INVALID');
      }
      seen = [];
      const locked = await act('verify', token, { code: '123456' });
      expect(locked.status).toBe(429);
      expect(locked.code).toBe('SECOND_FACTOR_LOCKED');
      const removal = await act('remove', token, { code: '123456' });
      expect(removal.code).toBe('SECOND_FACTOR_LOCKED');
      expect(seen).toEqual([]);
    });

    it('C59 canary: the authenticator secret and the provider’s words reach no log, record or refusal', async () => {
      const written: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(' '));
        }),
      );
      try {
        const token = await fresh(clientA);
        const enrolled = await act('enrol', token);
        // Shown once, to the person, in the enrol answer: that is the design.
        expect(enrolled.body['secret']).toBe(CANARY);
        replies['POST /factors/factor-one/verify'] = json(500, { msg: CANARY });
        const refused = await act('verify', token, { code: '123456' });
        expect(JSON.stringify(refused.body)).not.toContain(CANARY);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(written.join('\n')).not.toContain(CANARY);
      const stored = await world.db.app.withBusiness(world.alpha, async (tx) => {
        const tables = ['audit_events', 'authentication_attempts', 'second_factors'];
        const dumps = await Promise.all(
          tables.map(async (table) =>
            tx.query<{ readonly row: string }>(`select t::text as row from public.${table} t`),
          ),
        );
        return dumps.flat().map((row) => row.row);
      });
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.join('\n')).not.toContain(CANARY);
    });

    it('C59 isolation: another business, another client and a delegated agent never reach a factor', async () => {
      const before = await factorOf(world.mia.personId);
      // Mia has none left after the change above; give her one again to aim at.
      const token = await fresh(world.mia);
      expect((await act('enrol', token)).status).toBe(200);
      expect((await act('verify', token, { code: '123456' })).status).toBe(200);
      const target = await factorOf(world.mia.personId);
      expect(target).toMatchObject({ status: 'verified' });
      expect(before).toBeUndefined();
      seen = [];

      // Another business: Bea is bravo's, and alpha does not know her.
      const across = await act('remove', await fresh(world.bea), { code: '123456' });
      expect(across.status).toBe(403);
      expect(across.code).toBe('AUTH_NO_MEMBERSHIP');

      // Another client in the same business: client B acts only on client B's
      // own account, and a body naming anyone else's factor is refused.
      const other = await act('remove', await fresh(clientB), { code: '123456' });
      expect(other.code).toBe('FACTOR_NOT_ENROLLED');
      const named = await act('remove', await fresh(clientB), {
        code: '123456',
        factorId: target?.id,
      });
      expect(named.code).toBe('COMMAND_BODY_INVALID');

      // Another person under a live delegation: the agent acting for Ada finds
      // no factor route on its prefix at all.
      const agent = await call(
        api,
        agentPath('alpha', '/account/factor/remove'),
        { code: '123456' },
        bearer(world.agent.token),
      );
      expect(agent.status).toBe(404);

      expect(seen).toEqual([]);
      expect(await factorOf(world.mia.personId)).toEqual(target);
    });
  },
);

function subjectOf(caller: { readonly subject: string } | Member): string {
  return 'subject' in caller ? caller.subject : caller.presented.subject;
}
