// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's tick identity from the local seed (#859). `pnpm db:seed`
// (scripts/local-seed.mjs) makes the made-up businesses and each one's agent
// login, and keeps the agents' subjects in `.local/synthetic-agents.json`; this
// reads them back for the business the stack names. The seed makes no worker,
// so this makes the business one active worker actor, found first and inserted
// only when absent, through the application role inside that business.
//
// Local only: it refuses outside OPS_ENVIRONMENT=local before it opens a file
// or a database, and opens no database off this machine's loopback. A business or agent the seed has not made is refused, never
// made here.

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { isBusinessId } from '../../packages/core-records/src/index.ts';
import {
  advisoryLock,
  connect,
  connectAsAdmin,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { onThisMachine } from './settings.ts';
import { localOnly } from './tick.ts';

export interface LocalIdentity {
  readonly businessId: string;
  readonly agentSubject: string;
  readonly workerActorId: string;
}

export type IdentityRead =
  | { readonly ok: true; readonly identity: LocalIdentity }
  | {
      readonly ok: false;
      readonly code: 'LOCAL_ONLY' | 'NOT_SEEDED' | 'DATABASE_NOT_LOCAL';
      readonly message: string;
    };

const notSeeded = (what: string): IdentityRead => ({
  ok: false,
  code: 'NOT_SEEDED',
  message: `${what}: run pnpm db:seed first`,
});

/** The agent's login subject for a business key, from the seed's agents file. */
export function agentSubjectOf(agents: string, businessKey: string): string | undefined {
  let list: unknown;
  try {
    list = JSON.parse(agents);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const entry = (list as readonly Record<string, unknown>[]).find(
    (agent) => agent['business'] === businessKey,
  );
  const subject = entry?.['subject'];
  return typeof subject === 'string' && subject !== '' ? subject : undefined;
}

/** The seeded business, its agent's login and one active worker, made once. */
export async function localIdentity(
  db: { readonly admin: AdminConnection; readonly app: Database },
  businessKey: string,
  agentSubject: string,
): Promise<IdentityRead> {
  // Only the owner connection can find a business by its key; it only reads.
  const [business] = await db.admin.execute<{ id: string }>(
    'select id from public.businesses where key = $1',
    [businessKey],
  );
  if (business === undefined || !isBusinessId(business.id)) {
    return notSeeded(`no business ${businessKey}`);
  }
  return await db.app.withBusiness(business.id, async (tx) => {
    const agents = await tx.query(
      `select 1 from public.actors a
         join public.actor_logins al on al.business_id = a.business_id and al.actor_id = a.id
         join public.logins l on l.id = al.login_id
        where a.business_id = $1 and a.kind = 'agent' and a.active
          and l.provider = 'supabase' and l.subject = $2`,
      [tx.businessId, agentSubject],
    );
    if (agents.length === 0) return notSeeded(`no agent login in ${businessKey}`);
    // Two stacks starting together find or make the same worker, one after the other.
    await advisoryLock(tx, `local-agent-worker:${tx.businessId}`);
    const [held] = await tx.query<{ id: string }>(
      `select id from public.actors
        where business_id = $1 and kind = 'worker' and active order by id limit 1`,
      [tx.businessId],
    );
    let workerActorId = held?.id;
    if (workerActorId === undefined) {
      workerActorId = randomUUID();
      await tx.query(
        `insert into public.actors (business_id, id, kind, active) values ($1, $2, 'worker', true)`,
        [tx.businessId, workerActorId],
      );
    }
    return {
      ok: true,
      identity: { businessId: business.id, agentSubject, workerActorId },
    } satisfies IdentityRead;
  });
}

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The stack's lookup: the business named by OPS_LOCAL_AGENT_BUSINESS, the
 * database from the environment or the seed folder's `db.env`, the agent from
 * its `synthetic-agents.json`. The seed folder is OPS_SEED_DIR, else `.local`.
 */
export async function identityFromSeed(
  env: Readonly<Record<string, string | undefined>>,
): Promise<IdentityRead> {
  const refused = localOnly(env);
  if (refused !== undefined) return { ok: false, code: 'LOCAL_ONLY', message: refused.message };
  const businessKey = env['OPS_LOCAL_AGENT_BUSINESS'] ?? '';
  const folder = env['OPS_SEED_DIR'] || `${root}.local`;
  const held = readEnvFile(`${folder}/db.env`);
  const adminUrl = env['DATABASE_ADMIN_URL'] || held['DATABASE_ADMIN_URL'];
  const appUrl = env['DATABASE_URL'] || held['DATABASE_URL'];
  if (!adminUrl || !appUrl) return notSeeded('no local database settings');
  if (!onThisMachine(adminUrl) || !onThisMachine(appUrl)) {
    return {
      ok: false,
      code: 'DATABASE_NOT_LOCAL',
      message: 'the seed lookup connects only to a database on this machine',
    };
  }
  const agentsFile = `${folder}/synthetic-agents.json`;
  if (!existsSync(agentsFile)) return notSeeded('no synthetic-agents.json');
  const agentSubject = agentSubjectOf(readFileSync(agentsFile, 'utf8'), businessKey);
  if (agentSubject === undefined) return notSeeded(`no agent for ${businessKey}`);
  const admin = connectAsAdmin(adminUrl, { source: 'seed' });
  const app = connect(appUrl, { source: 'seed' });
  try {
    return await localIdentity({ admin, app }, businessKey, agentSubject);
  } finally {
    await app.close();
    await admin.close();
  }
}
