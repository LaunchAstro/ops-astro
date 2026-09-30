// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's planning budget suites' world (`aw-04-planning-budget*.test.ts`): the
// broker world, a second business on its database, a live pickup for the
// agent crossing, and the calls and reads the suites make.

import { randomUUID } from 'node:crypto';
import { beforeAll } from 'vitest';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  callModelForPlanning,
  readPlanningAllowance,
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
  type PlanningAllowance,
} from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  liveWork,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  LOCAL,
  PLANTED_PROMPT,
  digestOf,
  noDatabase,
  s,
  useBrokerWorld,
  withRoutes,
} from './broker-world.ts';

/** The world's live bindings, filled in by `usePlanningWorld`. */
export const p = {} as { bravo: Schedules; work: Work };

export function usePlanningWorld(label: string): void {
  useBrokerWorld(label);
  beforeAll(async () => {
    if (noDatabase) return;
    p.bravo = await seedSchedules(s.db, `${label}-bravo`, 1_000_000);
    p.work = await liveWork(s, `${label}-${randomUUID()}`, 2_000);
  }, 180_000);
}

export const ownerOf = (on: Schedules): ModelCaller => ({
  actorId: on.decider.actorId,
  delegationId: null,
  attendedByPersonId: on.decider.personId,
});

export const ask = (on: Schedules, id: string = randomUUID()): ConversationCallRequest => ({
  conversation: { id, businessId: on.business, ownerPersonId: on.decider.personId },
  operation: 'model.replay_compose',
  fields: [{ name: 'message', source: 'outside', value: PLANTED_PROMPT }],
});

/** The local route (planning replies keep AW-03's egress rule), audited as `on`'s agent. */
export const local = (on: Schedules): Broker => ({
  ...withRoutes([LOCAL]),
  audit: async (tx, note) => {
    await writeAuditEvent(tx, {
      actorId: on.agentActorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  },
});

export const plan = async (
  on: Schedules,
  caller: ModelCaller,
  request: ConversationCallRequest,
  database: Database = on.db.app,
): Promise<ModelCallResult> =>
  await callModelForPlanning(database, on.business, caller, request, local(on));

export async function setCap(on: Schedules, limitMinor: number): Promise<void> {
  await on.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', $3, 'AUD')`,
    [on.business, randomUUID(), limitMinor],
  );
}

export const allowance = async (
  on: Schedules,
  personId: string,
  conversationId: string,
): Promise<PlanningAllowance> =>
  await on.db.app.withBusiness(
    on.business,
    async (tx) => await readPlanningAllowance(tx, personId, conversationId),
  );

export const rowsFor = async (
  on: Schedules,
  id: string,
): Promise<readonly Record<string, unknown>[]> =>
  await on.db.admin.execute(`select * from public.model_calls where conversation_id = $1`, [id]);
