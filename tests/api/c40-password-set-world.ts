// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C40 reset cases open (ORCH77-C40B): the real API with
// `POST /api/password/set` mounted beside it, custody holding a made-up
// service key for the `auth` destination, a stand-in login provider on a
// loopback port whose one route is the admin update of one user, a broker
// that catalogues `auth.update_user_password`, and the people a reset is tried on. A reset token is minted here as the reset
// ask (C40 P2) will mint one: 32 random bytes, kept as their SHA-256 alone.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { mountPasswordSet, PASSWORD_SET_PATH } from '../../apps/api/password-set.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Broker, Custody } from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
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
import { brokerFor, routeDatabase } from './c40-password-set-broker.ts';
import { json, type Reply } from './c58-sessions-world.ts';

export { brokerFor } from './c40-password-set-broker.ts';

export const now = (): number => Math.floor(Date.now() / 1000);

/** The admin route's stand-in: the user named by the path's last segment, back. */
const userBack: Reply = (request, response) => {
  const id = (request.url ?? '').split('/').at(-1) ?? '';
  json(200, { id, email: 'x@example.test', aud: 'authenticated' })(request, response);
};

export interface Seen {
  readonly route: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export let world: World;
export let api: Hono;
export let seen: Seen[] = [];
export let serviceKey: string;
/** The broker the mounted route holds. */
export let broker: Broker;
export let clientA: Member;
export let clientB: Member;
let provider: Server;
let custody: Custody;
let folder: string;
let reply: Reply = userBack;
let faultIn: BusinessId | undefined;

/** The route's change in `business`, auditing and ending, fails after its work. */
export function faultTheChangeIn(business: BusinessId): void {
  faultIn = business;
}

/** The provider's next answer to the password update; back to a good one after each case. */
export function answerWith(next: Reply): void {
  reply = next;
}

/** An ordinary provider session's bearer, signed in at `signedInAt`. */
export const tokenFor = async (
  subject: string,
  sessionId: string,
  signedInAt: number,
): Promise<string> =>
  await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    exp: now() + 600,
    aal: 'aal1',
    session_id: sessionId,
    amr: [{ method: 'password', timestamp: signedInAt }],
  });

/**
 * A reset token for the login of `subject` in `business`, as the reset ask
 * mints one; `ageMinutes` back-dates it, so 31 is one past its life.
 */
export async function mintToken(
  subject: string,
  business: BusinessId = world.alpha,
  ageMinutes = 0,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await world.db.app.withBusiness(business, async (tx) => {
    await tx.query(
      `insert into password_reset_tokens
         (business_id, id, login_id, token_hash, created_at, expires_at)
       select $1, gen_random_uuid(), l.id, $3,
              now() - make_interval(mins => $4), now() - make_interval(mins => $4 - 30)
         from logins l where l.business_id = $1 and l.subject = $2`,
      [business, subject, createHash('sha256').update(token).digest('hex'), ageMinutes],
    );
  });
  return token;
}

/** Set a password with a token, as the reset page does. */
export const setPassword = async (token: string, password: unknown): Promise<Answer> =>
  await call(
    api as unknown as ReturnType<typeof createApi>,
    PASSWORD_SET_PATH,
    { token, password },
    {},
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
      reply(request, response);
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, '127.0.0.1', resolve);
  });
  folder = mkdtempSync(join(tmpdir(), 'c40p-'));
  serviceKey = `servicekey-${randomBytes(18).toString('hex')}`;
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const held = await brokerFor(origin, serviceKey, folder);
  custody = held.custody;
  broker = held.broker;
  const inner = createApi({
    database: world.db.app,
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
    resolveBusiness: async (key: string) =>
      await Promise.resolve({ alpha: world.alpha, bravo: world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
  });
  api = new Hono();
  mountPasswordSet(
    api,
    routeDatabase(world.db.app, () => faultIn),
    {
      businesses: async () => await Promise.resolve([world.alpha, world.bravo]),
      broker: held.broker,
    },
  );
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
    reply = userBack;
    seen = [];
    faultIn = undefined;
  });
  afterAll(async () => {
    if (serverUrl === undefined) return;
    provider?.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider?.close(() => resolve());
    });
    await custody?.stop();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    await world?.close();
  });
}
