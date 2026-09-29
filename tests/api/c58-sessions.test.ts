// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's session contract, the person's side: a person sees their sessions and
// ends the others, signs out of this one, and a second-factor change ends the
// others; each through the real API, against a stand-in sign-in provider on a
// loopback port, as C59's routes test stands one in.
//
// A session is the provider's `session_id` claim, which a refresh carries
// unchanged. Ending one is recorded here first, so the ended session's next
// call is refused at the door from the commit, whatever the provider does;
// the provider's sign-out, which revokes the refresh tokens, comes after.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from 'hono/jwt';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
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

const CANARY = 'CANARY-c58-session-words-4b1d7e';

const now = () => Math.floor(Date.now() / 1000);

type Reply = (request: IncomingMessage, response: ServerResponse) => void;

const json =
  (status: number, value: unknown): Reply =>
  (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

/** GoTrue's sign-out: 204 and no body, whatever the scope. */
const signedOut: Reply = (_request, response) => {
  response.writeHead(204);
  response.end();
};

const GOOD: Readonly<Record<string, Reply>> = {
  'POST /logout?scope=others': signedOut,
  'POST /logout?scope=local': signedOut,
  'POST /factors': json(200, {
    id: 'factor-one',
    type: 'totp',
    totp: { qr_code: 'data:,x', secret: 'S', uri: 'otpauth://totp/x' },
  }),
  'POST /factors/factor-one/challenge': json(200, { id: 'challenge-one', type: 'totp' }),
  'POST /factors/factor-one/verify': json(200, {
    access_token: 'aal2-access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
  }),
  'DELETE /factors/factor-one': json(200, { id: 'factor-one' }),
};

/** Each way a provider's sign-out answer can be wrong. None of them is done. */
const HOSTILE: Readonly<Record<string, Reply>> = {
  'a 200 with a body': json(200, { msg: CANARY }),
  'a 200 with no body': (_request, response) => {
    response.writeHead(200);
    response.end();
  },
  'a server error naming the canary': json(500, { msg: CANARY }),
  'a refusal': json(401, { msg: CANARY }),
  'a redirect to metadata': (_request, response) => {
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    response.end();
  },
  'an oversized answer': (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ pad: 'x'.repeat(64 * 1024) }));
  },
  'no answer in time': () => {
    // Never answers: the adapter's time limit ends the call.
  },
};

interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
}

type SessionView = {
  readonly sessionId: string;
  readonly current: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

describe.skipIf(serverUrl === undefined)('C58 a person’s own sessions, through the API', () => {
  let world: World;
  let provider: Server;
  let replies: Record<string, Reply> = { ...GOOD };
  let seen: Seen[] = [];
  let api: ReturnType<typeof createApi>;
  let clientA: Member;
  let clientB: Member;
  /** Client A's session through a factor change, kept from one case to the next. */
  const sessionKept = randomUUID();

  /** A bearer for one provider session, as GoTrue signs it. */
  const tokenFor = async (
    subject: string,
    sessionId: unknown,
    assurance?: { readonly aal: 'aal1' | 'aal2'; readonly totp?: number },
  ) =>
    await sign(
      {
        sub: subject,
        aud: 'authenticated',
        iss: ACCEPTANCE_ISSUER,
        exp: now() + 600,
        aal: assurance?.aal ?? 'aal1',
        session_id: sessionId,
        amr: [
          { method: 'password', timestamp: now() - 60 },
          ...(assurance?.totp === undefined ? [] : [{ method: 'totp', timestamp: assurance.totp }]),
        ],
      },
      ACCEPTANCE_SECRET,
      'HS256',
    );

  const sessions = async (
    name: 'list' | 'end-others' | 'sign-out',
    token: string,
    body: unknown = {},
    key = 'alpha',
  ) => await call(api, personPath(key, `/account/sessions/${name}`), body, bearer(token));

  /** A read the person could make a minute ago: their own capabilities. */
  const served = async (token: string, key = 'alpha') => {
    const answer = await call(api, personPath(key, '/session/capabilities'), {}, bearer(token));
    return { status: answer.status, code: answer.code };
  };

  const listOf = async (token: string, key = 'alpha') => {
    const answer = await sessions('list', token, {}, key);
    expect(answer.status).toBe(200);
    return (answer.body as { readonly sessions: readonly SessionView[] }).sessions;
  };

  const eventsFor = async (command: string) =>
    await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await tx.query<{ readonly outcome: string; readonly refusal_code: string | null }>(
          `select outcome, refusal_code from public.audit_events
          where command = $1 order by seq`,
          [command],
        ),
    );

  const endedCount = async () =>
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const rows = await tx.query<{ readonly n: number }>(
        'select count(*)::int as n from public.ended_sessions',
      );
      return rows[0]?.n ?? 0;
    });

  const EXPIRED = { status: 401, code: 'AUTH_SESSION_EXPIRED' } as const;
  const OK = { status: 200, code: 'ok' } as const;

  beforeAll(async () => {
    world = await createWorld('c58s');
    provider = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const route = `${request.method} ${request.url}`;
        seen.push({ route, authorization: request.headers.authorization });
        const reply =
          new Map(Object.entries(replies)).get(route) ?? json(404, { msg: 'no such route' });
        reply(request, response);
      });
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, '127.0.0.1', resolve);
    });
    api = createApi({
      database: world.db.app,
      verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET, issuer: ACCEPTANCE_ISSUER }),
      resolveBusiness: async (key: string) =>
        await Promise.resolve({ alpha: world.alpha, bravo: world.bravo }[key]),
      executeCommand,
      executeRead,
      executeAgentCommand,
      factors: createGoTrueFactors({
        baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
        timeoutMs: 300,
      }),
    });

    const tasks: string[] = [];
    for (const title of ['client A work', 'client B work']) {
      // oxlint-disable-next-line no-await-in-loop
      const created = await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
        command: 'task.create',
        operationId: `c58s-${randomUUID()}`,
        fields: { title },
      });
      if (isCommandRefusal(created) || created.recordId === null) {
        throw new Error('task.create did not create the fixture task');
      }
      tasks.push(created.recordId);
    }
    const sharer = world.ada as unknown as Member;
    clientA = await shareWithClient(world.db.app, world.alpha, sharer, tasks[0] ?? '');
    clientB = await shareWithClient(world.db.app, world.alpha, sharer, tasks[1] ?? '');
  }, 60_000);

  afterEach(() => {
    replies = { ...GOOD };
    seen = [];
  });

  afterAll(async () => {
    provider?.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider?.close(() => resolve());
    });
    await world?.close();
  });

  it('C58 end other sessions: a person sees their sessions and ends the others, and only the others', async () => {
    const [here, phone, laptop] = [randomUUID(), randomUUID(), randomUUID()];
    const token = await tokenFor(world.mia.subject, here);
    const phoneToken = await tokenFor(world.mia.subject, phone);
    const laptopToken = await tokenFor(world.mia.subject, laptop);
    for (const each of [phoneToken, laptopToken, token]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(each)).toEqual(OK);
    }

    const before = await listOf(token);
    expect(before.map((row) => row.sessionId).toSorted()).toEqual([here, phone, laptop].toSorted());
    expect(before.filter((row) => row.current).map((row) => row.sessionId)).toEqual([here]);
    expect(seen).toEqual([]);

    const ended = await sessions('end-others', token);
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ ended: 2, signedOutAtProvider: true });
    // The provider is asked once, with the person's own bearer: `others`
    // revokes every other session's refresh token and leaves this one.
    expect(seen).toEqual([
      { route: 'POST /logout?scope=others', authorization: `Bearer ${token}` },
    ]);

    expect(await served(phoneToken)).toEqual(EXPIRED);
    expect(await served(laptopToken)).toEqual(EXPIRED);
    // A refreshed token for an ended session carries the same session id.
    expect(await served(await tokenFor(world.mia.subject, phone))).toEqual(EXPIRED);
    expect(await served(token)).toEqual(OK);
    expect((await listOf(token)).map((row) => row.sessionId)).toEqual([here]);
    expect((await eventsFor('account.sessions_end_others')).at(-1)).toEqual({
      outcome: 'applied',
      refusal_code: null,
    });

    // Asked again with nothing left to end: nothing more is ended, and the
    // provider is asked again (an unseen session may still hold a token).
    const again = await sessions('end-others', token);
    expect(again.body).toEqual({ ended: 0, signedOutAtProvider: true });
  });

  it('C58 refresh revoked: signing out ends this session here and at the provider, and no other', async () => {
    const [here, other] = [randomUUID(), randomUUID()];
    const token = await tokenFor(clientB.presented.subject, here);
    const otherToken = await tokenFor(clientB.presented.subject, other);
    expect(await served(otherToken)).toEqual(OK);

    const out = await sessions('sign-out', token);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ended: 1, signedOutAtProvider: true });
    expect(seen).toEqual([{ route: 'POST /logout?scope=local', authorization: `Bearer ${token}` }]);
    expect(await served(token)).toEqual(EXPIRED);
    expect(await served(otherToken)).toEqual(OK);
    expect((await eventsFor('account.sign_out')).at(-1)).toEqual({
      outcome: 'applied',
      refusal_code: null,
    });
  });

  it('C58 refresh revoked: a second-factor change ends every other session, here and at the provider', async () => {
    const subject = clientA.presented.subject;
    const [here, other] = [sessionKept, randomUUID()];
    const token = await tokenFor(subject, here);
    const otherToken = await tokenFor(subject, other);
    expect(await served(otherToken)).toEqual(OK);

    expect(
      (await call(api, personPath('alpha', '/account/factor/enrol'), {}, bearer(token))).status,
    ).toBe(200);
    seen = [];
    const verified = await call(
      api,
      personPath('alpha', '/account/factor/verify'),
      { code: '123456' },
      bearer(token),
    );
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      accessToken: 'aal2-access-token',
      otherSessions: { ended: 1, signedOutAtProvider: true },
    });
    // The sign-out uses the session the code just raised, which is the one kept.
    expect(seen.map((request) => request.route)).toEqual([
      'POST /factors/factor-one/challenge',
      'POST /factors/factor-one/verify',
      'POST /logout?scope=others',
    ]);
    expect(seen.at(-1)?.authorization).toBe('Bearer aal2-access-token');
    expect(await served(otherToken)).toEqual(EXPIRED);
  });

  it('C58 refresh revoked: removing the second factor ends every other session too', async () => {
    // Client A's factor, completed above, from the session kept there.
    const subject = clientA.presented.subject;
    const here = sessionKept;
    const aal2 = await tokenFor(subject, here, { aal: 'aal2', totp: now() - 30 });
    const third = await tokenFor(subject, randomUUID(), { aal: 'aal2', totp: now() - 30 });
    expect(await served(third)).toEqual(OK);
    seen = [];
    const removed = await call(
      api,
      personPath('alpha', '/account/factor/remove'),
      { code: '123456' },
      bearer(aal2),
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      removed: true,
      otherSessions: { ended: 1, signedOutAtProvider: true },
    });
    expect(seen.map((request) => request.route)).toEqual([
      'POST /factors/factor-one/challenge',
      'POST /factors/factor-one/verify',
      'DELETE /factors/factor-one',
      'POST /logout?scope=others',
    ]);
    expect(await served(third)).toEqual(EXPIRED);
    expect(await served(await tokenFor(subject, here))).toEqual(OK);
  });

  it('C58 hostile provider: a sign-out the provider does not confirm is not done, and the local end stands', async () => {
    for (const [index, [name, reply]] of Object.entries(HOSTILE).entries()) {
      const [here, other] = [randomUUID(), randomUUID()];
      // oxlint-disable-next-line no-await-in-loop
      const [token, otherToken] = await Promise.all([
        tokenFor(world.ada.subject, here),
        tokenFor(world.ada.subject, other),
      ]);
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(otherToken)).toEqual(OK);
      replies = { ...GOOD, 'POST /logout?scope=others': reply };
      // oxlint-disable-next-line no-await-in-loop
      const ended = await sessions('end-others', token);
      expect(ended.status, name).toBe(200);
      // The other session, and from the second round the last round's own.
      expect(ended.body, name).toEqual({ ended: index === 0 ? 1 : 2, signedOutAtProvider: false });
      expect(JSON.stringify(ended.body), name).not.toContain(CANARY);
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(otherToken), name).toEqual(EXPIRED);
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(token), name).toEqual(OK);
    }
    // The redirect was never followed: every call went to the provider alone.
    expect(seen.every((request) => request.route === 'POST /logout?scope=others')).toBe(true);
  });

  it('C58 end other sessions: a body, a session id that is no uuid and a stale sign-out are refused or ignored', async () => {
    const here = randomUUID();
    const token = await tokenFor(world.mia.subject, here);
    const before = await endedCount();
    for (const body of [{ sessionId: here }, { scope: 'global' }, [], 'x']) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await sessions('end-others', token, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.code).toBe('COMMAND_BODY_INVALID');
    }
    expect(seen).toEqual([]);
    expect(await endedCount()).toBe(before);

    // A session claim that is not a provider session id names no session: it
    // is never recorded, listed or ended, and cannot end a session by guess.
    for (const odd of [`${here}' or 1=1`, CANARY, 42, '']) {
      // oxlint-disable-next-line no-await-in-loop
      const odder = await tokenFor(world.mia.subject, odd);
      // oxlint-disable-next-line no-await-in-loop
      const listed = await listOf(odder);
      expect(listed.some((row) => row.current)).toBe(false);
      expect(JSON.stringify(listed)).not.toContain(CANARY);
    }
    expect(await served(token)).toEqual(OK);
  });

  it('C58 isolation: another business and another client never see or end a person’s session', async () => {
    const [adaHere, bSession, aSession] = [randomUUID(), randomUUID(), randomUUID()];
    const [adaToken, clientBToken, clientAToken] = await Promise.all([
      tokenFor(world.ada.subject, adaHere),
      tokenFor(clientB.presented.subject, bSession),
      tokenFor(clientA.presented.subject, aSession),
    ]);
    for (const each of [adaToken, clientBToken, clientAToken]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(each)).toEqual(OK);
    }

    // Another business: Bea is bravo's. Her own sessions list in bravo, and
    // none of alpha's; in alpha she is nobody.
    const beaToken = await tokenFor(world.bea.subject, randomUUID());
    const beaList = await listOf(beaToken, 'bravo');
    for (const id of [adaHere, bSession, aSession])
      expect(JSON.stringify(beaList)).not.toContain(id);
    expect((await sessions('end-others', beaToken, {}, 'alpha')).code).toBe('AUTH_NO_MEMBERSHIP');
    expect(await sessions('end-others', beaToken, {}, 'bravo')).toMatchObject({ status: 200 });

    // Another client in the same business: client A's list holds client A's
    // sessions alone, and ending client A's others leaves client B served.
    const aList = await listOf(clientAToken);
    expect(aList.every((row) => row.sessionId !== bSession && row.sessionId !== adaHere)).toBe(
      true,
    );
    expect(
      (await sessions('end-others', await tokenFor(clientA.presented.subject, randomUUID())))
        .status,
    ).toBe(200);
    expect(await served(clientAToken)).toEqual(EXPIRED);
    expect(await served(clientBToken)).toEqual(OK);
    expect(await served(adaToken)).toEqual(OK);
  });

  it('C58 isolation: the agent acting for Ada under a live delegation finds no session route', async () => {
    const adaToken = await tokenFor(world.ada.subject, randomUUID());
    expect(await served(adaToken)).toEqual(OK);
    for (const name of ['list', 'end-others', 'sign-out']) {
      // oxlint-disable-next-line no-await-in-loop
      const agent = await call(
        api,
        agentPath('alpha', `/account/sessions/${name}`),
        {},
        bearer(world.agent.token),
      );
      expect(agent.status).toBe(404);
    }
    expect(await served(adaToken)).toEqual(OK);
  });

  it('C58 canary: the provider’s words reach no answer, refusal or record', async () => {
    const token = await tokenFor(world.noah.subject, randomUUID());
    replies = { ...GOOD, 'POST /logout?scope=others': json(500, { msg: CANARY }) };
    const answer = await sessions('end-others', token);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    const stored = await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await tx.query<{ readonly text: string }>(
          `select concat_ws(' ', (select string_agg(to_jsonb(e)::text, ' ') from public.audit_events e),
                              (select string_agg(to_jsonb(s)::text, ' ') from public.ended_sessions s),
                              (select string_agg(to_jsonb(a)::text, ' ') from public.authentication_attempts a)) as text`,
        ),
    );
    expect(stored[0]?.text ?? '').not.toContain(CANARY);
  });
});
