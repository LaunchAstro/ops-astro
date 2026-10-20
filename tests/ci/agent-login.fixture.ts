// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's world (agent-login-*.test.ts): a migrated database
// reached as staging's project through the Sydney pooler's name (moved to
// loopback by pooler-at-loopback.mjs), an operator and an agent owner in
// alpha, and a stand-in for the sign-in provider on loopback that serves its
// key set and logs every other call. `runAct` runs the tool, and fails
// `TOOL_ABSENT` while there is none.

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  connectAsAdmin,
  type AdminConnection,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { signBearer, TEST_KEY_SET } from '../support/sign-in.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { POOLER, projectRef } from './production-bootstrap.fixture.ts';

const TOOL = new URL('../../scripts/ops/agent-login.ts', import.meta.url).pathname;
export const PRODUCTION: string = projectRef();
const STAGING: string = projectRef();
export const secret = (): string => `${TEST_ONLY_MARKER}-${randomBytes(18).toString('hex')}`;

/** The provider on loopback: the calls made to it past its key set. */
export interface Provider {
  readonly url: string;
  readonly calls: string[];
  close(): Promise<void>;
}

export type Answer = readonly [number, unknown];
/** What the provider answers a call past its key set: by default, nothing there. */
export type Handler = (call: { method: string; route: string; text: string }) => Promise<Answer>;
const reply = (response: ServerResponse, [status, body]: Answer): void => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

async function serveProvider(handle: Handler): Promise<Provider> {
  const calls: string[] = [];
  const answer = async (request: IncomingMessage, text: string): Promise<Answer> => {
    const route = (request.url ?? '').replace(/^\/auth\/v1/u, '');
    if (route === '/.well-known/jwks.json') return [200, TEST_KEY_SET];
    const method = request.method ?? '';
    calls.push(`${method} ${route.split('?')[0] ?? ''}`);
    return await handle({ method, route, text });
  };
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => void answer(request, text).then((said) => reply(response, said)));
  });
  for (let port = 54730; port < 54740; port += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the first of this suite's ten ports that is free
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) {
      const close = (): Promise<void> =>
        new Promise((resolve) => {
          server.close(() => resolve());
        });
      return { url: `http://127.0.0.1:${port}/auth/v1`, calls, close };
    }
  }
  throw new Error('no loopback port free for the provider');
}

/** The world every case acts in. */
export interface World {
  readonly db: FreshDatabase;
  readonly provider: Provider;
  readonly alpha: string;
  readonly beta: string;
  readonly operatorPerson: string;
  readonly ownerPerson: string;
  readonly ownerActor: string;
  readonly operatorSession: string;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  close(): Promise<void>;
}

/** An admin and a runtime login on staging's project, as the pooler names them. */
async function poolerLogins(server: AdminConnection, serverUrl: string, database: string) {
  const [admin, runtime] = ['ad', 'rt'].map((kind) => ({
    login: `al_${kind}_${randomBytes(4).toString('hex')}.${STAGING}`,
    password: secret(),
  })) as [{ login: string; password: string }, { login: string; password: string }];
  // The hosted admin owns every object; here the server's superuser did, so its stand-in is one.
  await server.execute(`create role "${admin.login}" login superuser password '${admin.password}'`);
  await server.execute(
    `create role "${runtime.login}" login password '${runtime.password}' nosuperuser nobypassrls inherit in role ops_astro_app`,
  );
  const address = ({ login, password }: { login: string; password: string }): string => {
    const url = new URL(serverUrl);
    Object.assign(url, { hostname: POOLER, username: login, password, pathname: `/${database}` });
    url.search = '?sslmode=require';
    return url.toString();
  };
  return { admin: address(admin), runtime: address(runtime), logins: [admin, runtime] };
}

/** Olive, alpha's operator over the whole business, and Owen, who owns its agents. */
async function people(tx: TenantQuery, operatorSubject: string) {
  const operator = await insertPerson(tx, 'Olive');
  const operatorActor = await insertActor(tx, operator);
  await insertMembership(tx, operator);
  await insertMapping(tx, await insertLogin(tx, operatorSubject), operator, operatorActor);
  const issued = await issueGrant(tx, [{ kind: 'actor', id: operatorActor }], {
    subject: { kind: 'person', id: operator },
    scope: { kind: 'business', id: null },
    collection: 'operations',
    action: 'manage',
    parentGrantId: null,
    grantedByActorId: operatorActor,
  });
  if (!issued.ok) throw new Error('the operator grant was refused');
  const owner = await insertPerson(tx, 'Owen');
  await insertMembership(tx, owner);
  return { operator, owner, ownerActor: await insertActor(tx, owner) };
}

export async function makeWorld(
  serverUrl: string,
  handle: Handler = async () => await Promise.resolve([404, {}]),
): Promise<World> {
  const db = await createFreshDatabase({ part: 'agentlogin' });
  const server = connectAsAdmin(serverUrl, { source: 'harness' });
  const reach = await poolerLogins(server, serverUrl, db.name);
  const provider = await serveProvider(handle);
  const records = mkdtempSync(join(tmpdir(), 'agent-login-'));
  const [alpha, beta] = [
    await insertBusiness(db.app, 'alpha'),
    await insertBusiness(db.app, 'beta'),
  ];
  const [operatorSubject, operatorSession] = [randomUUID(), randomUUID()];
  const cast = await db.app.withBusiness(alpha, async (tx) => await people(tx, operatorSubject));
  const claims = { sub: operatorSubject, aud: 'authenticated', iss: provider.url };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await signBearer({
    ...claims,
    role: 'authenticated',
    exp,
    session_id: operatorSession,
  });
  const serviceKey = secret();
  const env = {
    PATH: process.env['PATH'] ?? '',
    STAGING_PROJECT_REF: STAGING,
    PRODUCTION_PROJECT_REF: PRODUCTION,
    DATABASE_ADMIN_URL: reach.admin,
    DATABASE_URL: reach.runtime,
    GOTRUE_URL: provider.url,
    SUPABASE_SERVICE_KEY: serviceKey,
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_DEPLOYMENTS: records,
  };
  const close = async (): Promise<void> => {
    await provider.close();
    rmSync(records, { recursive: true, force: true });
    await db.drop();
    await server.execute(
      `drop role if exists ${reach.logins.map((one) => `"${one.login}"`).join(', ')}`,
    );
    await server.close();
  };
  const secrets = [...reach.logins.map((login) => login.password), serviceKey, token];
  const { operator: operatorPerson, owner: ownerPerson, ownerActor } = cast;
  const named = { operatorPerson, ownerPerson, ownerActor };
  return { db, provider, alpha, beta, operatorSession, env, secrets, close, ...named };
}

let agents = 0;
/** A new agent of `business` (alpha), owned by `owner` (Owen), named Helper <n>. */
export async function agentOf(
  world: World,
  options: { active?: boolean; business?: string; owner?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const active = options.active ?? true;
  agents += 1;
  await world.db.admin.execute(
    `insert into public.actors
       (business_id, id, kind, active, deactivated_at, display_name, owner_person_id)
     values ($1, $2, 'agent', $3, $4, $5, $6)`,
    [
      options.business ?? world.alpha,
      id,
      active,
      active ? null : new Date(),
      `Helper ${agents}`,
      options.owner ?? world.ownerPerson,
    ],
  );
  return id;
}

/** Fails `TOOL_ABSENT` while the tool is not there. */
export function toolPresent(): void {
  if (!existsSync(TOOL)) throw new Error('TOOL_ABSENT: scripts/ops/agent-login.ts');
}

export interface Run {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly password?: string;
  /** Called at each named point of the act; a throw there is a crash at that point. */
  readonly at?: (point: string) => Promise<void>;
}

/** One run of the tool, in this process: its exit status and everything it printed. */
export async function runAct(world: World, run: Run): Promise<{ status: number; printed: string }> {
  toolPresent();
  const tool = (await import(TOOL)) as {
    runAgentLogin: (...parts: unknown[]) => Promise<{ status: number; lines: string[] }>;
  };
  const env = { ...world.env, ...run.env };
  const done = await tool.runAgentLogin(
    env,
    run.args,
    async () => await Promise.resolve(run.password ?? secret()),
    { at: run.at },
  );
  return { status: done.status, printed: done.lines.join('\n') };
}

/** The make arguments for `agent`, with a fresh address on the never-mailed domain. */
export const makeArgs = (
  agent: string,
  email = `helper-${randomBytes(4).toString('hex')}@example.test`,
): string[] => ['make', '--agent', agent, '--email', email];

export const actsOf = async (
  world: World,
  agent: string,
): Promise<readonly Record<string, unknown>[]> =>
  await world.db.admin.execute<Record<string, unknown>>(
    'select * from ops.agent_login_acts where agent_actor_id = $1',
    [agent],
  );

export const mappingsOf = async (
  world: World,
  agent: string,
): Promise<readonly { login_id: string; linked_by_actor_id: string; subject: string }[]> =>
  await world.db.admin.execute<{ login_id: string; linked_by_actor_id: string; subject: string }>(
    `select m.login_id, m.linked_by_actor_id, l.subject from public.actor_logins m
       join public.logins l on l.business_id = m.business_id and l.id = m.login_id
      where m.actor_id = $1 and m.active`,
    [agent],
  );

/** Resolves once a session of this database waits on an advisory lock. */
export async function waitingOnTheLock(world: World): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until a run waits
    const [row] = await world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`,
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until a run waits
    await sleep(50);
  }
  throw new Error('no run waited on the agent lock');
}
