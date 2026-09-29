// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the AW-01 broker cases share, one per test file: a schedules
// database with work really proposed, approved and picked up, custody's real
// process, the replay provider on loopback, and a broker over them. The
// bindings are live: `s`, `world` and `broker` are set by `useBrokerWorld`'s
// beforeAll and read by the cases after it.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  type AuditNote,
  type Broker,
  type BrokerRoute,
  type ModelCallField,
  type ModelCaller,
  type ModelCallRequest,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  createTask,
  openSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export const digestOf = (detail: unknown): string =>
  createHash('sha256').update(JSON.stringify(detail)).digest('hex');

export const PLANTED_PROMPT: string = `planted-prompt-${randomUUID()}`;

export const CLOUD: BrokerRoute = {
  key: 'replay',
  reach: 'cloud',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1_000,
};

export const LOCAL: BrokerRoute = { ...CLOUD, key: 'on_premises', reach: 'local' };

export const ONE_AT_A_TIME: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_single',
  concurrency: 1,
};

export const NOT_RECONCILABLE: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_unreconcilable',
  nothingHappened: 'not_reconcilable',
};

/**
 * Business-internal fields only: the cloud route may carry them. The field is
 * bound to a task a person of the business entered, titled the planted
 * prompt, because only the broker can find a source business-internal (S3).
 * Set by `useBrokerWorld`'s beforeAll.
 */
export let INTERNAL: readonly ModelCallField[] = [];

export let s: Schedules;
export let world: CustodyWorld;
export let broker: Broker;

export const withRoutes = (routes: readonly BrokerRoute[]): Broker => ({ ...broker, routes });

const audit = async (tx: TenantQuery, note: AuditNote): Promise<void> => {
  await writeAuditEvent(tx, {
    actorId: s.agentActorId,
    command: note.action,
    outcome: note.outcome,
    refusalCode: note.refusalCode,
    payloadDigest: digestOf(note.detail),
    attempted: note.outcome === 'refused' ? note.detail : null,
  });
};

const steps = new Map<string, string>();
export const stepOf = async (work: Work): Promise<string> => {
  const leaseId = String(work.picked['leaseId']);
  const known = steps.get(leaseId);
  if (known !== undefined) return known;
  const [row] = await s.db.admin.execute<{ id: string }>(
    `select st.id from public.planned_steps st join public.leases l on l.run_id = st.run_id
      where l.id = $1 order by st.ordinal limit 1`,
    [leaseId],
  );
  if (row === undefined) throw new Error('no step for the lease');
  steps.set(leaseId, row.id);
  return row.id;
};

export const requestFor = (
  work: Work,
  overrides: Partial<ModelCallRequest> = {},
): ModelCallRequest => ({
  leaseId: String(work.picked['leaseId']),
  fence: Number(work.picked['fence']),
  stepId: steps.get(String(work.picked['leaseId'])) ?? 'unknown',
  operation: REPLAY_COMPOSE.key,
  fields: INTERNAL,
  ...overrides,
});

/** The agent, under the delegation its pickup of this work minted. */
export const caller = (work: Work): ModelCaller => ({
  actorId: s.agentActorId,
  delegationId: String(work.picked['delegationId']),
  attendedByPersonId: null,
});

export const call = async (
  work: Work,
  overrides: Partial<ModelCallRequest> = {},
  with_: Broker = broker,
): Promise<ModelCallResult> => {
  await stepOf(work);
  return await callModel(s.db.app, s.business, caller(work), requestFor(work, overrides), with_);
};

export const rowsOf = async (callId: string | null): Promise<readonly Record<string, unknown>[]> =>
  callId === null
    ? []
    : await s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query(`select * from public.model_calls where business_id = $1 and id = $2`, [
            tx.businessId,
            callId,
          ]),
      );

export const rowsOnLease = async (work: Work): Promise<readonly Record<string, unknown>[]> =>
  await s.db.admin.execute(`select id from public.model_calls where lease_id = $1`, [
    work.picked['leaseId'],
  ]);

export const callCount = async (): Promise<number> =>
  Number(
    (
      await s.db.admin.execute<{ n: string }>(`select count(*)::text as n from public.model_calls`)
    )[0]?.n,
  );

/** Opens the world before the file's cases and closes it after them. */
export function useBrokerWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    s = await openSchedules(label, 1_000_000);
    INTERNAL = [
      { name: 'tone', from: { recordId: await createTask(s, PLANTED_PROMPT), key: 'title' } },
    ];
    world = await openCustodyWorld();
    broker = {
      custody: world.custody,
      operations: catalogue([REPLAY_COMPOSE, ONE_AT_A_TIME, NOT_RECONCILABLE]),
      providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
      routes: [CLOUD],
      installation: 'here',
      audit,
    };
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    await s?.db.drop();
  });
}
