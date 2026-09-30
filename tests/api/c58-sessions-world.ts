// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `c58-sessions.test.ts` opens: its stand-ins, callers and helpers, split from
// that file to keep it under the line limit. Its hooks are called at module
// level there, under the same skip as its cases.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  ACCEPTANCE_ISSUER,
  bearer,
  call,
  createWorld,
  type Answer,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';

export const CANARY = 'CANARY-c58-session-words-4b1d7e';

export const now = (): number => Math.floor(Date.now() / 1000);

export type Reply = (request: IncomingMessage, response: ServerResponse) => void;

export const json =
  (status: number, value: unknown): Reply =>
  (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

/** GoTrue's sign-out: 204 and no body, whatever the scope. */
export const signedOut: Reply = (_request, response) => {
  response.writeHead(204);
  response.end();
};

export const GOOD: Readonly<Record<string, Reply>> = {
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
export const HOSTILE: Readonly<Record<string, Reply>> = {
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

export interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
}

export type SessionView = {
  readonly sessionId: string;
  readonly current: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

export let world: World;
let provider: Server;
let replies: Record<string, Reply> = { ...GOOD };
export let seen: Seen[] = [];

/** The next case's provider answers, per route; `resetProvider` puts back `GOOD`. */
export function answerWith(next: Record<string, Reply>): void {
  replies = next;
}

/** Forget the routes the provider has seen so far. */
export function forgetSeen(): void {
  seen = [];
}
export let api: ReturnType<typeof createApi>;
export let clientA: Member;
export let clientB: Member;
/** Client A's session through a factor change, kept from one case to the next. */
export const sessionKept: string = randomUUID();

/** A bearer for one provider session, as GoTrue signs it. */
export const tokenFor = async (
  subject: string,
  sessionId: unknown,
  assurance?: { readonly aal: 'aal1' | 'aal2'; readonly totp?: number },
): Promise<string> =>
  await signBearer({
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
  });

export const sessions = async (
  name: 'list' | 'end-others' | 'sign-out',
  token: string,
  body: unknown = {},
  key = 'alpha',
): Promise<Answer> =>
  await call(api, personPath(key, `/account/sessions/${name}`), body, bearer(token));

/** A read the person could make a minute ago: their own capabilities. */
export const served = async (
  token: string,
  key = 'alpha',
): Promise<{ readonly status: number; readonly code: string }> => {
  const answer = await call(api, personPath(key, '/session/capabilities'), {}, bearer(token));
  return { status: answer.status, code: answer.code };
};

export const listOf = async (token: string, key = 'alpha'): Promise<readonly SessionView[]> => {
  const answer = await sessions('list', token, {}, key);
  expect(answer.status).toBe(200);
  return (answer.body as { readonly sessions: readonly SessionView[] }).sessions;
};

export const eventsFor = async (
  command: string,
): Promise<readonly { readonly outcome: string; readonly refusal_code: string | null }[]> =>
  await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await tx.query<{ readonly outcome: string; readonly refusal_code: string | null }>(
        `select outcome, refusal_code from public.audit_events
        where command = $1 order by seq`,
        [command],
      ),
  );

export const endedCount = async (): Promise<number> =>
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const rows = await tx.query<{ readonly n: number }>(
      'select count(*)::int as n from public.ended_sessions',
    );
    return rows[0]?.n ?? 0;
  });

export const EXPIRED: { readonly status: 401; readonly code: 'AUTH_SESSION_EXPIRED' } = {
  status: 401,
  code: 'AUTH_SESSION_EXPIRED',
};
export const OK: { readonly status: 200; readonly code: 'ok' } = { status: 200, code: 'ok' };

export async function openSessionsWorld(): Promise<void> {
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
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
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
}

export function resetProvider(): void {
  replies = { ...GOOD };
  seen = [];
}

export async function closeSessionsWorld(): Promise<void> {
  provider?.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider?.close(() => resolve());
  });
  await world?.close();
}

/** The hooks a test file opening this world calls at module level, under its cases' skip. */
export function useSessionsWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await openSessionsWorld();
  }, 60_000);
  afterEach(() => {
    if (serverUrl === undefined) return;
    resetProvider();
  });
  afterAll(async () => {
    if (serverUrl === undefined) return;
    await closeSessionsWorld();
  });
}
