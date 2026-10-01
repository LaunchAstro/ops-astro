// SPDX-License-Identifier: AGPL-3.0-only
//
// The world for AW-11's spend suites: picked-up work whose delegation reaches
// `task` and `run`, a helper agent holding a child of it, custody's own
// process and the replay provider, and `model.call` through the real
// executor (the agent entry, the envelope, the broker).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  modelCallExecutor,
  type ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import type { Broker, ModelCaller } from '../../packages/core-custody/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { child, insertHelper, parentWork, type Helper } from '../runtime/aw-11-child-world.ts';
import {
  seedSchedules,
  openSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export interface SpendWorld {
  s: Schedules;
  bravo: Schedules;
  custody: CustodyWorld;
  helper: Helper;
  bravoHelper: Helper;
  call: ModelCallExecutor;
  broker: Broker;
}

export const w = {} as SpendWorld;

export function useSpendWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.s = await openSchedules(label, 1_000_000);
    w.bravo = await seedSchedules(w.s.db, `${label}-bravo`, 1_000_000);
    for (const on of [w.s, w.bravo]) {
      // Sequential: one business at a time.
      // oxlint-disable-next-line no-await-in-loop
      await on.db.app.withBusiness(on.business, async (tx) => {
        await grantTo(tx, on.decider, 'write', undefined, true, 'run');
      });
    }
    w.helper = await insertHelper(w.s);
    w.bravoHelper = await insertHelper(w.bravo);
    w.custody = await openCustodyWorld();
    w.custody.provider.mode('answer');
    const config = {
      custody: w.custody.custody,
      operations: catalogue([REPLAY_COMPOSE]),
      providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
      routes: [
        {
          key: 'replay',
          reach: 'cloud' as const,
          provider: 'replay',
          credentialRef: 'replay_key',
          credentialKind: 'api_key' as const,
          installation: 'here',
          ceiling: 1_000,
        },
      ],
      installation: 'here',
    };
    w.call = modelCallExecutor(config);
    w.broker = { ...config, audit: async () => await Promise.resolve() };
  }, 180_000);
  afterAll(async () => {
    await w.custody?.close();
    await w.s?.db.drop();
  });
}

/** Picked-up work with `maximumMinor` on its envelope, and a child for the helper. */
export async function childSpend(
  on: Schedules,
  helper: Helper,
  maximumMinor: number,
  title = `aw-11 spend ${randomUUID()}`,
): Promise<{
  readonly work: Work;
  readonly parentCredential: string;
  readonly childCredential: string;
  readonly childId: string;
}> {
  const { work, parent, credential } = await parentWork(on, title, maximumMinor);
  const minted = await child(on, parent, helper, {
    collections: ['task'],
    actions: ['read', 'write'],
  });
  return {
    work,
    parentCredential: credential,
    childCredential: minted.credential,
    childId: minted.delegation.id,
  };
}

/** `model.call` on the parent's lease, as `presented` on `credential`. */
export async function callOn(
  on: Schedules,
  work: Work,
  presented: Helper['presented'],
  credential: string,
): Promise<CommandResult> {
  return await w.call(on.db.app, on.business, presented, credential, {
    command: 'model.call',
    operationId: randomUUID(),
    leaseId: work.picked['leaseId'],
    fence: work.picked['fence'],
    operation: REPLAY_COMPOSE.key,
    fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
  } as never);
}

/** The broker's caller for a child: the helper under its child delegation. */
export const childCaller = (helper: Helper, childId: string): ModelCaller => ({
  actorId: helper.actorId,
  delegationId: childId,
  attendedByPersonId: null,
});

export interface CallRow {
  readonly state: string;
  readonly reserved_minor: string;
  readonly actual_minor: string | null;
}

export async function callsOn(on: Schedules, work: Work): Promise<readonly CallRow[]> {
  return [
    ...(await on.db.admin.execute<CallRow>(
      `select state, reserved_minor::text as reserved_minor, actual_minor::text as actual_minor
         from public.model_calls where lease_id = $1 order by accepted_at`,
      [work.picked['leaseId']],
    )),
  ];
}
