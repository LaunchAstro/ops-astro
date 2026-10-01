// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `c40-password-set.test.ts` opens: the real API with C40's
// `POST /api/password/set` mounted beside it, a stand-in login provider on a
// loopback port that sets passwords and signs out (C58's stand-in, plus
// `PUT /user`), and the people a reset is tried on.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { mountPasswordSet, PASSWORD_SET_PATH } from '../../apps/api/password-set.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  ACCEPTANCE_ISSUER,
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { enrol, shareWithClient, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { json, signedOut, type Reply } from './c58-sessions-world.ts';

export const now = (): number => Math.floor(Date.now() / 1000);

/** The subject a bearer names, read back off its unverified middle: the stand-in's view. */
const subjectOf = (request: IncomingMessage): string => {
  const token = (request.headers.authorization ?? '').replace(/^Bearer /u, '');
  const middle = token.split('.')[1] ?? '';
  try {
    return String(JSON.parse(Buffer.from(middle, 'base64url').toString('utf8')).sub);
  } catch {
    return '';
  }
};

/** GoTrue's `PUT /user`: the caller's own user back. */
const userBack: Reply = (request, response) => {
  json(200, { id: subjectOf(request), email: 'x@example.test', aud: 'authenticated' })(
    request,
    response,
  );
};

export const GOOD: Readonly<Record<string, Reply>> = {
  'PUT /user': userBack,
  'POST /logout?scope=others': signedOut,
  'POST /logout?scope=local': signedOut,
};

export interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export let world: World;
export let api: Hono;
export let seen: Seen[] = [];
let provider: Server;
let replies: Record<string, Reply> = { ...GOOD };
export let clientA: Member;
export let clientB: Member;

/** The next answers, per route; the stand-in goes back to `GOOD` after each case. */
export function answerWith(next: Record<string, Reply>): void {
  replies = next;
}

/** A provider session's bearer: `recovery` when the reset link opened it, else a password sign-in. */
export const tokenFor = async (
  subject: string,
  sessionId: string,
  how: 'recovery' | 'password',
  signedInAt: number,
  expiresAt: number = now() + 600,
): Promise<string> =>
  await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    exp: expiresAt,
    aal: 'aal1',
    session_id: sessionId,
    amr: [{ method: how, timestamp: signedInAt }],
  });

/** Set a password with a bearer, as the reset page does. */
export const setPassword = async (token: string | undefined, password: unknown): Promise<Answer> =>
  await call(
    api as unknown as ReturnType<typeof createApi>,
    PASSWORD_SET_PATH,
    { password },
    token === undefined ? {} : bearer(token),
  );

/** Whether a session is served past the door in a business (any answer but a door refusal). */
export const doorAnswer = async (token: string, key = 'alpha'): Promise<string> => {
  const answer = await call(
    api as unknown as ReturnType<typeof createApi>,
    personPath(key, '/session/capabilities'),
    {},
    bearer(token),
  );
  return answer.status === 401 ? String(answer.body['code']) : 'served';
};

/** The same login admitted in bravo too, as a member there. */
export async function inBravoToo(subject: string, name: string): Promise<string> {
  return await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return actorId;
  });
}

/** A new member of alpha, with a login of their own. */
export const freshMember = async (name: string): Promise<Member> =>
  await enrol(world.db.app, world.alpha, `${name}-${randomUUID().slice(0, 8)}`);

export interface AuditRow {
  readonly actor_id: string;
  readonly command: string;
  readonly outcome: string;
  readonly row: string;
}

/** Every audit row of `command` in a business, each as its whole JSON too. */
export const auditOf = async (business: string, command: string): Promise<readonly AuditRow[]> =>
  await world.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<AuditRow>(
        `select actor_id, command, outcome, to_jsonb(a)::text as row
           from public.audit_events a where command = $1 order by seq`,
        [command],
      ),
  );

async function openWorld(): Promise<void> {
  world = await createWorld('c40p');
  provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const route = `${request.method} ${request.url}`;
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ route, authorization: request.headers.authorization, body });
      const found = new Map(Object.entries(replies)).get(route);
      const reply = typeof found === 'function' ? found : json(404, { msg: 'no such route' });
      reply(request, response);
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, '127.0.0.1', resolve);
  });
  const verify = createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER));
  const factors = createGoTrueFactors({
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
    timeoutMs: 300,
  });
  const inner = createApi({
    database: world.db.app,
    verify,
    resolveBusiness: async (key: string) =>
      await Promise.resolve({ alpha: world.alpha, bravo: world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    factors,
  });
  api = new Hono();
  mountPasswordSet(api, world.db.app, {
    businesses: async () => await Promise.resolve([world.alpha, world.bravo]),
    provider: factors,
    verify,
  });
  api.route('/', inner);
  await openClients();
}

/** Clients A and B of alpha: each shared one task of ada's, nothing more. */
async function openClients(): Promise<void> {
  const tasks: string[] = [];
  for (const title of ['client A work', 'client B work']) {
    // oxlint-disable-next-line no-await-in-loop
    const created = await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
      command: 'task.create',
      operationId: `c40p-${randomUUID()}`,
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

/** The hooks the test file calls at module level, under its cases' skip. */
export function usePasswordWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await openWorld();
  }, 60_000);
  afterEach(() => {
    replies = { ...GOOD };
    seen = [];
  });
  afterAll(async () => {
    if (serverUrl === undefined) return;
    provider?.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider?.close(() => resolve());
    });
    await world?.close();
  });
}
