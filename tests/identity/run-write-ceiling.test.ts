// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's `run:write` inside an agent's delegation (ORCH34 ruling): the `run`
// collection carries one action, `write`. A delegation's reach is its
// collections times its actions, so the mint and the per-call check hold `run`
// to that ceiling: a mint whose person holds `run:write` reaches it and
// nothing else on `run`, a mint that asks `run` for no `write` is refused by
// name, and a delegation on `task` alone is exactly what it was.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  mintDelegation,
  type DelegableAction,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { issueGrant, type Action } from '../../packages/core-records/src/authority/grants.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const TASK_WORK = ['read', 'comment', 'write'] as const;

interface Person {
  readonly personId: string;
  readonly actorId: string;
}

/** A member of the business holding `grants` at business scope. */
async function person(
  tx: TenantQuery,
  name: string,
  grants: readonly (readonly [string, Action])[],
): Promise<Person> {
  const personId = await insertPerson(tx, name);
  const actorId = await insertActor(tx, personId);
  await insertMembership(tx, personId);
  for (const [collection, action] of grants) {
    // oxlint-disable-next-line no-await-in-loop -- issueGrant reads the granter's rows
    const issued = await issueGrant(tx, [{ kind: 'person', id: personId }], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection,
      action,
      parentGrantId: null,
      grantedByActorId: actorId,
    });
    if (!issued.ok) throw new Error(`fixture: ${collection}:${action} ${issued.refusal.code}`);
  }
  return { personId, actorId };
}

// eslint-disable-next-line max-lines-per-function -- one business, each ceiling case on it
describe.skipIf(serverUrl === undefined)('run:write ceiling on a delegation', () => {
  let db: FreshDatabase;
  let business: string;
  let taskId: string;
  /** A real task the delegation was not minted for. */
  let siblingId: string;
  /** Holds task read, comment and write, and no run grant. */
  let ada: Person;
  /** Holds the same, and run:write. */
  let bea: Person;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'runceil' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      const task = TASK_WORK.map((action) => ['task', action] as const);
      ada = await person(tx, 'Ada', task);
      bea = await person(tx, 'Bea', [...task, ['run', 'write']]);
      const spine = await installTaskSpine(tx);
      taskId = randomUUID();
      siblingId = randomUUID();
      for (const [id, title] of [
        [taskId, 'the picked-up task'],
        [siblingId, 'its sibling'],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one insert at a time
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [business, id, spine.taskTypeId, { title }],
        );
      }
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** One mint for a fresh agent, as `who`, over `collections` times `actions`. */
  const mint = async (
    who: Person,
    collections: readonly string[],
    actions: readonly DelegableAction[],
  ) =>
    await db.app.withBusiness(business, async (tx) =>
      mintDelegation(tx, {
        agentActorId: await insertAgentActor(tx),
        delegatePersonId: who.personId,
        mintedByActorId: who.actorId,
        purpose: 'task_work',
        collections,
        actions,
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );

  const reach = async (held: Delegation, collection: string, action: Action, on = taskId) =>
    await db.app.withBusiness(business, (tx) =>
      checkDelegatedAuthority(tx, held, { collection, action, scope: { kind: 'record', id: on } }),
    );

  it('run:write ceiling: a mint of task and run carries run:write and nothing else on run', async () => {
    const minted = await mint(bea, ['task', 'run'], TASK_WORK);
    if (!minted.ok) throw new Error(`the mint was refused ${minted.refusal.code}`);
    const held = minted.value.delegation;
    expect((await reach(held, 'run', 'write')).ok).toBe(true);
    // Outside its delegation: run:write on a sibling task is the one-task ceiling's refusal.
    const sibling = await reach(held, 'run', 'write', siblingId);
    expect(sibling.ok ? 'reached' : sibling.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    for (const action of ['read', 'comment', 'share', 'manage'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction each
      const refused = await reach(held, 'run', action);
      expect(refused.ok ? 'reached' : refused.refusal.code, action).toBe(
        'DELEGATION_OUT_OF_PURPOSE',
      );
    }
    for (const action of TASK_WORK) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction each
      expect((await reach(held, 'task', action)).ok, action).toBe(true);
    }
  });

  it('run:write ceiling: a mint asking run for read, comment, share or manage alone is refused by name', async () => {
    for (const action of ['read', 'comment', 'share', 'manage'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one mint at a time
      const minted = await mint(bea, ['run'], [action]);
      expect(minted.ok, action).toBe(false);
      if (minted.ok) continue;
      expect(minted.refusal.code, action).toBe('DELEGATION_WIDENS');
      expect(JSON.stringify(minted.refusal), action).toContain('run carries write only');
    }
  });

  it('run:write ceiling: a mint asking run for decide is refused, as every decide is', async () => {
    const minted = await mint(bea, ['run'], ['decide' as DelegableAction]);
    expect(minted.ok ? 'minted' : minted.refusal.code).toBe('DELEGATION_EXCLUDES_DECISION');
  });

  it('run:write ceiling: a person without run:write mints no run reach', async () => {
    const minted = await mint(ada, ['task', 'run'], TASK_WORK);
    expect(minted.ok ? 'minted' : minted.refusal.code).toBe('DELEGATION_WIDENS');
    expect(JSON.stringify(minted)).toContain('write grant on run');
  });

  it('run:write ceiling: a delegation on task alone is unchanged and reaches no run', async () => {
    const minted = await mint(ada, ['task'], TASK_WORK);
    if (!minted.ok) throw new Error(`the mint was refused ${minted.refusal.code}`);
    expect(minted.value.delegation.collections).toStrictEqual(['task']);
    expect(minted.value.delegation.actions).toStrictEqual([...TASK_WORK]);
    const refused = await reach(minted.value.delegation, 'run', 'write');
    expect(refused.ok ? 'reached' : refused.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');
  });
});
