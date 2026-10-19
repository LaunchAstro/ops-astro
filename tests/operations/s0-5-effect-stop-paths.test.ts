// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on the stops #1623 R1 added to commands
// that did not stop an attempt before: a pickup that fences an expired lease,
// a cancel, a supersession and a grant revocation each record the attempt's
// outcome and release the call it reserved and never sent (`recordStop`,
// `broker-stop.ts`). Each path runs once on live work holding one unsent
// call; it must write both tables, and its command must declare both. Other
// tables these paths write are outside the stop's own writes and are not
// judged here.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  asPerson,
  asAgent,
  codeOf,
  freshPurpose,
  liveWork,
  openSchedules,
  proposeBody,
  revisionOf,
  rows,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { unsentCall } from '../runtime/version-room-world.ts';
import { changed, fingerprint, undeclared } from './s0-5-effect-diff.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';

const STOP_WRITES = ['model_calls', 'run_outcomes'];

let s: Schedules;
let manager: Member;
const noDatabase = databaseUrlFromEnvironment() === undefined;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('s05stop', 1_000_000);
  // The decider cannot revoke its own grant; a manager does (T5).
  manager = await enrol(s.db.app, s.business, 'manager');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'manage'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, manager, action);
    }
  });
}, 120_000);
afterAll(async () => {
  await s?.db.drop();
});

/** The lease and its delegation both past their windows, as R5's sweep finds them. */
async function expireWork(work: Work): Promise<void> {
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second'
      where business_id = $1 and id = $2`,
    [s.business, work.picked['leaseId']],
  );
  await s.db.admin.execute(
    `update public.delegations
        set granted_at = least(granted_at, clock_timestamp() - interval '2 seconds'),
            expires_at = clock_timestamp() - interval '1 second'
      where business_id = $1 and id = $2`,
    [s.business, work.picked['delegationId']],
  );
}

interface StopPath {
  readonly name: CommandName;
  act(work: Work): Promise<string>;
}

const PATHS: readonly StopPath[] = [
  {
    // R5: the replacement fences the expired lease and records LEASE_EXPIRED.
    name: 'task.pickup',
    act: async (work) => {
      await expireWork(work);
      return codeOf(
        await asAgent(s, {
          command: 'task.pickup',
          operationId: randomUUID(),
          reservationId: work.decision['reservationId'],
          leaseSeconds: 600,
        }),
      );
    },
  },
  {
    name: 'task.cancel',
    act: async (work) =>
      codeOf(
        await asPerson(s, {
          command: 'task.cancel',
          operationId: randomUUID(),
          recordId: work.taskId,
          lineageId: work.proposal['lineageId'],
          reason: 'stopped with a call never sent',
        }),
      ),
  },
  {
    // R8: a new version on the lineage supersedes the live one.
    name: 'task.propose',
    act: async (work) =>
      codeOf(
        await asPerson(
          s,
          proposeBody(work.taskId, await revisionOf(s, work.taskId), {
            lineageId: String(work.proposal['lineageId']),
            purpose: freshPurpose(),
          }),
        ),
      ),
  },
  {
    // T5: the approver's task write goes, and with it the agent's work authority.
    name: 'grant.revoke',
    act: async () => {
      const [grant] = await rows<{ id: string }>(
        s,
        `select id from public.grants
          where business_id = $1 and subject_kind = 'person' and subject_id = $2
            and collection = 'task' and action = 'write' and revoked_at is null`,
        [s.business, s.decider.personId],
      );
      return codeOf(
        await executeCommand(s.db.app, s.business, manager.presented, 'api', {
          command: 'grant.revoke',
          operationId: randomUUID(),
          grantId: grant?.id,
        } as never),
      );
    },
  },
];

it.skipIf(noDatabase).each(PATHS)(
  "S0-5 gate coverage of each stop: $name's stop releases the unsent call, and it declares the stop's writes",
  async (path) => {
    const work = await liveWork(s, `s0-5 stop ${path.name} ${randomUUID()}`, 2_000);
    await unsentCall(s, work.decision['reservationId'], 100);
    const before = await fingerprint(s.db.admin);
    expect(await path.act(work)).toBe('applied');
    const written = changed(before, await fingerprint(s.db.admin));
    expect(STOP_WRITES.filter((table) => !written.includes(table))).toStrictEqual([]);
    expect(undeclared(path.name, STOP_WRITES)).toStrictEqual([]);
  },
  120_000,
);
