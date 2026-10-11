// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent record migrations (20261011115838, 20261011115839) over an installation that used
// 0082's Assign to AI, in two businesses. Each task holding a delegation comes
// to hold that delegation's agent; an agent gets an owner only where one is
// plain (its credential's issuer, or the one person whose own delegations of
// it held tasks); an agent several people's delegations held keeps none; and
// nothing crosses a business. Then a person's read names the agent and owner.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const MIGRATION = '20261011115838_agent_record';
const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('agent-record-upgrade: DATABASE_URL is unset.');

interface Installed {
  readonly business: string;
  readonly p: Member;
  readonly q: Member;
  /** Held by P's delegation alone. */
  readonly solo: { readonly agent: string; readonly task: string; readonly delegation: string };
  /** Held by P's and Q's delegations, on two tasks. */
  readonly shared: { readonly agent: string; readonly tasks: readonly string[] };
  /** An agent credential's agent, issued by Q. */
  readonly issued: string;
}

let db: EmptyDatabase;
let alpha: Installed;
let bravo: Installed;

const newAgent = async (business: string): Promise<string> => {
  const id = randomUUID();
  await db.admin.execute(
    `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
    [business, id],
  );
  return id;
};

const taskBy = async (business: string, by: Member, title: string): Promise<string> => {
  const made = await executeCommand(db.app, business, by.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  return made.recordId ?? '';
};

/** A delegation of `by`'s for `agent` on `task`, and the task holding it, as 0082 wrote it. */
const heldUnder0082 = async (business: string, by: Member, agent: string, task: string) => {
  const delegation = await db.app.withBusiness(business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId: agent,
      delegatePersonId: by.personId,
      mintedByActorId: by.actorId,
      purpose: `old_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!made.ok) throw new Error(`mint refused ${made.refusal.code}`);
    return made.value.delegation.id;
  });
  await db.admin.execute(
    `update public.records set data = data || jsonb_build_object('agent', $2::text) where id = $1`,
    [task, delegation],
  );
  return delegation;
};

async function install(key: string): Promise<Installed> {
  const business = await insertBusiness(db.app, `${key}-${randomUUID().slice(0, 8)}`);
  await installSpine(db.app, business);
  const p = await enrol(db.app, business, `${key}-p`);
  const q = await enrol(db.app, business, `${key}-q`);
  await db.app.withBusiness(business, async (tx) => {
    for (const member of [p, q]) {
      for (const action of ['read', 'write', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- a few grants
        await grantTo(tx, member, action);
      }
    }
  });
  const soloAgent = await newAgent(business);
  const soloTask = await taskBy(business, p, `${key} solo`);
  const delegation = await heldUnder0082(business, p, soloAgent, soloTask);
  const sharedAgent = await newAgent(business);
  const tasks = [await taskBy(business, p, `${key} shared p`), await taskBy(business, q, 'q')];
  await heldUnder0082(business, p, sharedAgent, tasks[0] ?? '');
  await heldUnder0082(business, q, sharedAgent, tasks[1] ?? '');
  const issued = await newAgent(business);
  await db.admin.execute(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, 'old credential', array['task:read'], $6, 'hmac-sha256-v1',
             'k1', now() + interval '1 day')`,
    [business, randomUUID(), issued, q.personId, q.actorId, 'a'.repeat(64)],
  );
  return {
    business,
    p,
    q,
    solo: { agent: soloAgent, task: soloTask, delegation },
    shared: { agent: sharedAgent, tasks },
    issued,
  };
}

const ownerOf = async (agent: string): Promise<string | null | undefined> =>
  (
    await db.admin.execute<{ readonly owner: string | null }>(
      `select owner_person_id::text as owner from public.actors where id = $1`,
      [agent],
    )
  )[0]?.owner;

const heldBy = async (task: string): Promise<{ agent: string | null; revision: string }> => {
  const rows = await db.admin.execute<{ agent: string | null; revision: string }>(
    `select data ->> 'agent' as agent, revision::text as revision from public.records where id = $1`,
    [task],
  );
  return rows[0] ?? { agent: null, revision: '' };
};

let revisionBefore = '';

/** Two businesses installed at the prefix before the migration, then the migration and the rest. */
async function upgraded(): Promise<void> {
  db = await createEmptyDatabase({ part: 'agentrec' });
  const migrations = readMigrations('migrations');
  const index = migrations.findIndex((m) => m.version === MIGRATION);
  if (index <= 0) throw new Error('the agent record migration is not after an installed prefix');
  await applyMigrations(db.admin, migrations.slice(0, index));
  alpha = await install('alpha');
  bravo = await install('bravo');
  revisionBefore = (await heldBy(alpha.solo.task)).revision;
  await db.closeSessions();
  const migrated = await applyMigrations(db.admin, migrations);
  expect(migrated.applied[0]).toBe(MIGRATION);
}

describe.skipIf(serverUrl === undefined)('the agent record migration', () => {
  beforeAll(upgraded, 180_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('a task held by a delegation now names that delegation’s agent, at a new revision', async () => {
    for (const world of [alpha, bravo]) {
      // eslint-disable-next-line no-await-in-loop -- two businesses
      expect((await heldBy(world.solo.task)).agent).toBe(world.solo.agent);
      for (const task of world.shared.tasks) {
        // eslint-disable-next-line no-await-in-loop -- two tasks
        expect((await heldBy(task)).agent).toBe(world.shared.agent);
      }
    }
    expect(Number((await heldBy(alpha.solo.task)).revision)).toBe(Number(revisionBefore) + 1);
  });

  it('owners are given only where plain, and only within the business', ownersWherePlain);

  it('the delegation itself is untouched, and a person’s read names the agent and its owner', async () => {
    const live = await db.admin.execute<{ readonly revoked: boolean }>(
      `select revoked_at is not null as revoked from public.delegations where id = $1`,
      [alpha.solo.delegation],
    );
    expect(live[0]?.revoked).toBe(false);
    const read = await executeRead(db.app, alpha.business, alpha.q.presented, {
      read: 'task.read',
      recordId: alpha.solo.task,
    });
    if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
    expect(read.task.agent).toMatchObject({
      agentId: alpha.solo.agent,
      name: 'AI agent',
      owner: { personId: alpha.p.personId },
      live: true,
    });
  });

  it('a person actor or a worker cannot be given a name or an owner', notAnAgentsName);
});

async function notAnAgentsName(): Promise<void> {
  await expect(
    db.admin.execute(`update public.actors set display_name = 'Not an agent' where id = $1`, [
      alpha.p.actorId,
    ]),
  ).rejects.toThrow(/actors_name_and_owner_are_an_agents/u);
}

async function ownersWherePlain(): Promise<void> {
  for (const world of [alpha, bravo]) {
    /* eslint-disable no-await-in-loop -- two businesses */
    expect(await ownerOf(world.solo.agent)).toBe(world.p.personId);
    expect(await ownerOf(world.shared.agent)).toBeNull();
    expect(await ownerOf(world.issued)).toBe(world.q.personId);
    /* eslint-enable no-await-in-loop */
  }
  const crossed = await db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.actors a
       join public.people p on p.id = a.owner_person_id
      where p.business_id <> a.business_id`,
  );
  expect(crossed[0]?.n).toBe('0');
}
