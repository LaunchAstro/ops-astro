// SPDX-License-Identifier: AGPL-3.0-only
//
// The world for AW-11's two suites: an agent under a live delegation minted by
// a real pickup (the parent, reaching `task` and `run`), a helper agent of the
// same business with a login of its own (the child's holder), and a second
// business with its own picked-up work.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  mintChildDelegation,
  resolveDelegation,
  type ChildMintRequest,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertLogin } from '../identity/fixture.ts';
import {
  asAgent,
  codeOf as commandCode,
  liveWork,
  openSchedules,
  rows,
  seedSchedules,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export interface Helper {
  readonly actorId: string;
  readonly presented: VerifiedSubject;
}

export interface ChildWorld {
  s: Schedules;
  bravo: Schedules;
  helper: Helper;
  bravoHelper: Helper;
  /** Picked up before the decider held `run:write`: its delegation reaches `task` only. */
  taskOnly: Delegation;
  taskOnlyWork: Work;
  taskOnlyCredential: string;
}

export const w = {} as ChildWorld;

/** Another agent of `on`'s business, signed in as itself. */
export async function insertHelper(on: Schedules): Promise<Helper> {
  const actorId = randomUUID();
  const subject = `helper-${randomUUID()}`;
  await on.db.app.withBusiness(on.business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      on.business,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [on.business, randomUUID(), await insertLogin(tx, subject), actorId, on.decider.actorId],
    );
  });
  return { actorId, presented: { provider: 'supabase', subject } };
}

/** The decider holds `run:write`, so a pickup's delegation reaches `run` (MP-6-2). */
async function grantRunWrite(on: Schedules): Promise<void> {
  await on.db.app.withBusiness(on.business, async (tx) => {
    await grantTo(tx, on.decider, 'write', undefined, true, 'run');
  });
}

export function useChildWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.s = await openSchedules(label, 1_000_000);
    w.bravo = await seedSchedules(w.s.db, `${label}-bravo`, 1_000_000);
    const taskOnly = await parentWork(w.s);
    w.taskOnly = taskOnly.parent;
    w.taskOnlyWork = taskOnly.work;
    w.taskOnlyCredential = taskOnly.credential;
    await grantRunWrite(w.s);
    await grantRunWrite(w.bravo);
    w.helper = await insertHelper(w.s);
    w.bravoHelper = await insertHelper(w.bravo);
  }, 180_000);
  afterAll(async () => {
    await w.s?.db.drop();
  });
}

/** Fresh picked-up work and the parent delegation its pickup minted. */
export async function parentWork(
  on: Schedules,
  title = `aw-11 ${randomUUID()}`,
  maximumMinor = 2_000,
): Promise<{ readonly work: Work; readonly parent: Delegation; readonly credential: string }> {
  const work = await liveWork(on, title, maximumMinor);
  const credential = String(work.picked['credential']);
  const parent = await on.db.app.withBusiness(
    on.business,
    async (tx) => await resolveDelegation(tx, on.agentActorId, credential),
  );
  if (!parent.ok) throw new Error(`the parent did not resolve: ${parent.refusal.code}`);
  return { work, parent: parent.value, credential };
}

let purposes = 0;

export function childRequest(
  helper: Helper,
  overrides: Partial<ChildMintRequest> = {},
): ChildMintRequest {
  purposes += 1;
  return {
    agentActorId: helper.actorId,
    purpose: `helper_${String(purposes)}`,
    collections: ['task'],
    actions: ['read'],
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

export async function mintChild(
  on: Schedules,
  parent: Delegation,
  request: ChildMintRequest,
): ReturnType<typeof mintChildDelegation> {
  return await on.db.app.withBusiness(
    on.business,
    async (tx) => await mintChildDelegation(tx, parent, request),
  );
}

export const mintedCode = (result: Awaited<ReturnType<typeof mintChild>>): string =>
  result.ok ? 'minted' : result.refusal.code;

/** A child minted or a throw naming the refusal. */
export async function child(
  on: Schedules,
  parent: Delegation,
  helper: Helper,
  overrides: Partial<ChildMintRequest> = {},
): Promise<{ readonly delegation: Delegation; readonly credential: string }> {
  const minted = await mintChild(on, parent, childRequest(helper, overrides));
  if (!minted.ok) throw new Error(`the child was refused: ${minted.refusal.code}`);
  return minted.value;
}

/** `task.read` through the agent entry, as the helper on its child's credential. */
export async function readAsHelper(
  on: Schedules,
  helper: Helper,
  credential: string,
  recordId: string,
): ReturnType<typeof asAgent> {
  return await asAgent(
    { ...on, agent: helper.presented },
    { command: 'task.read', operationId: randomUUID(), recordId },
    credential,
  );
}

export const callCode: typeof commandCode = commandCode;

/**
 * A row written straight through the application role, bypassing every line
 * of `mintChildDelegation`: what the database itself admits. Copies the
 * parent's identity columns unless overridden. Answers `inserted` or the
 * Postgres error's message.
 */
/** The parent's identity columns, which a raw child copies unless overridden. */
async function rawRow(
  on: Schedules,
  parentId: string | null,
  overrides: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const found = await rows<Record<string, unknown>>(
    on,
    `select delegate_person_id, minted_by_actor_id, purpose_scope_id
       from public.delegations where business_id = $1 and id = $2`,
    [on.business, parentId],
  );
  const parent = found[0];
  return {
    delegate_person_id: parent?.['delegate_person_id'] ?? on.decider.personId,
    minted_by_actor_id: parent?.['minted_by_actor_id'] ?? on.decider.actorId,
    collections: ['task'],
    actions: ['read'],
    purpose_scope_id: parent?.['purpose_scope_id'] ?? randomUUID(),
    ...overrides,
  };
}

/**
 * A row written straight through the application role, bypassing every line
 * of `mintChildDelegation`: what the database itself admits. Answers
 * `inserted` or the Postgres error's message.
 */
export async function insertRaw(
  on: Schedules,
  parentId: string | null,
  helper: Helper,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const row = await rawRow(on, parentId, overrides);
  purposes += 1;
  try {
    await on.db.app.withBusiness(on.business, async (tx) => {
      await tx.query(
        `insert into public.delegations
           (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
            collections, actions, purpose_scope_kind, purpose_scope_id, credential_hash,
            expires_at, parent_delegation_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'record', $9, $10,
                 now() + interval '1 hour', $11)`,
        [
          on.business,
          randomUUID(),
          helper.actorId,
          row['delegate_person_id'],
          row['minted_by_actor_id'],
          `raw_${String(purposes)}`,
          row['collections'],
          row['actions'],
          row['purpose_scope_id'],
          randomUUID().replaceAll('-', '').repeat(2),
          parentId,
        ],
      );
    });
    return 'inserted';
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** An update straight through the application role; `updated` or the error's message. */
export async function updateRaw(
  on: Schedules,
  id: string,
  assignment: string,
  parameters: readonly unknown[] = [],
): Promise<string> {
  try {
    await on.db.app.withBusiness(on.business, async (tx) => {
      await tx.query(
        `update public.delegations set ${assignment} where business_id = $1 and id = $2`,
        [on.business, id, ...parameters],
      );
    });
    return 'updated';
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
