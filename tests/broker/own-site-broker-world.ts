// SPDX-License-Identifier: AGPL-3.0-only
//
// R6 part 2's world (#1699), one per test file: C80's command-layer world
// with the business's own site bound (no party), custody's real process and
// the replay provider on loopback, and a broker over them whose one route is
// the owner's subscription. The bindings are live: `w` is set by
// `useOwnSiteWorld`'s beforeAll and read by the cases after it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  type Broker,
  type BrokerRoute,
  type ModelCallField,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import type { PickedUp } from '../commands/agent-fixture.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { CLOUD, digestOf } from './broker-world.ts';
import { c80World, requestBody, type C80World } from '../site/c80-world.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const SEAT: BrokerRoute = { ...CLOUD, key: 'owners_seat', credentialKind: 'subscription' };
const OWN_FILE = 'src/pages/our-about.md';
const OWN_PAGE = `https://own-${randomUUID().slice(0, 8)}.example/about`;

export let w: C80World;
let custody: CustodyWorld;
let broker: Broker;

/** The world's person `personId` holding `role` from now on, as the product changes a role. */
export async function movesTo(personId: string, role: string): Promise<void> {
  await w.world.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [w.world.business, personId],
  );
  await w.world.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [w.world.business, randomUUID(), personId, role],
  );
}

/** The world for one file: alpha's own site bound, custody and the replay provider running. */
export function useOwnSiteWorld(part: string): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    w = await c80World(part);
    custody = await openCustodyWorld();
    broker = {
      custody: custody.custody,
      operations: catalogue([REPLAY_COMPOSE]),
      providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
      routes: [SEAT],
      installation: 'here',
      audit: async (tx, note) => {
        await writeAuditEvent(tx, {
          actorId: w.world.agentActorId,
          command: note.action,
          outcome: note.outcome,
          refusalCode: note.refusalCode,
          payloadDigest: digestOf(note.detail),
          attempted: note.outcome === 'refused' ? note.detail : null,
        });
      },
    };
    const bound = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) =>
        await bindPartySite(
          tx,
          {
            partyId: null,
            repository: `own/site-${randomUUID().slice(0, 8)}`,
            defaultBranch: 'main',
            project: 'prj_own_1699',
            pages: [{ pageUrl: OWN_PAGE, path: OWN_FILE }],
          },
          w.admin.actorId,
        ),
    );
    if (!bound.ok) throw new Error(`own site: bind refused ${bound.code}`);
  }, 180_000);

  afterAll(async () => {
    if (serverUrl === undefined) return;
    await custody?.close();
    await w?.world.drop();
  });
}

/** Ava, holding `role` when she creates the task, has it approved and picked up by the agent. */
export async function workedBy(role: 'owner' | 'member', title: string): Promise<PickedUp> {
  await movesTo(w.ava.personId, role);
  return await w.world.pickUp(w.ava, `${title} ${randomUUID().slice(0, 6)}`);
}

/** The task's title as the free-text field, bound to the run's own task. */
export const freeText = (taskId: string): readonly ModelCallField[] => [
  { name: 'instruction', from: { recordId: taskId, key: 'title' } },
];

/** The agent's model call on the picked-up work, attended by the person it works for. */
export async function ask(
  picked: PickedUp,
  fields: readonly ModelCallField[] = freeText(picked.taskId),
  routes: readonly BrokerRoute[] = [SEAT],
): Promise<ModelCallResult> {
  const leaseId = String(picked.detail['leaseId']);
  const [step] = await w.world.db.admin.execute<{ readonly id: string }>(
    `select st.id from public.planned_steps st join public.leases l on l.run_id = st.run_id
      where l.id = $1 order by st.ordinal limit 1`,
    [leaseId],
  );
  return await callModel(
    w.world.db.app,
    w.world.business,
    {
      actorId: w.world.agentActorId,
      delegationId: String(picked.detail['delegationId']),
      attendedByPersonId: w.ava.personId,
    },
    {
      leaseId,
      fence: Number(picked.detail['fence']),
      stepId: String(step?.id),
      operation: REPLAY_COMPOSE.key,
      fields,
    },
    { ...broker, routes },
  );
}

/** The agent's request on the business's own about page, under its delegation. */
export const requestOwn = async (
  picked: PickedUp,
  body: Readonly<Record<string, unknown>> = ownBody(picked),
): Promise<CommandResult> => await w.world.asAgent(body, picked.credential);

/** The body of that request, with an operation id of its own: sent twice, a replay. */
export const ownBody = (picked: PickedUp): Readonly<Record<string, unknown>> => ({
  ...requestBody(w.partyA, picked.taskId),
  page: OWN_PAGE,
  operationId: randomUUID(),
});

export const sends = (): number => custody.provider.seen.length;

export const storedOn = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

/** An applied write on the task by `actorId`, as the register records one. */
export async function wrote(taskId: string, actorId: string): Promise<void> {
  await w.world.db.admin.execute(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`,
    [w.world.business, randomUUID(), `r6-${randomUUID()}`, actorId, '0'.repeat(64), taskId],
  );
}

/** A person of the business with no staff role: a client's contact. */
export async function clientContact(): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const personId = await insertPerson(tx, 'Client contact');
    const actorId = await insertActor(tx, personId);
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key, active)
       values ($1, $2, $3, 'client_contact', true)`,
      [tx.businessId, randomUUID(), personId],
    );
    return actorId;
  });
}
