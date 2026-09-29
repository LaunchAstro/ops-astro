// SPDX-License-Identifier: AGPL-3.0-only
//
// The C4 change-record suites' harness: read *changes since* as a member,
// stamp tasks, and take an exact point.

import {
  changesSince,
  type BusinessId,
  type ChangesSince,
} from '../../packages/core-records/src/index.ts';
import type { Subject } from '../../packages/core-records/src/authority/grants.ts';
import type { Member } from '../commands/fixture.ts';
import type { Party } from '../runtime/cq-8-world.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';

export const subjects = (who: Member): Subject[] => [
  { kind: 'person', id: who.personId },
  { kind: 'actor', id: who.actorId },
];

export const ids = (read: ChangesSince): string[] => read.changes.map((change) => change.id);

export const tasksOf = (p: Party): [string, string] => {
  const [one, two] = p.tasks;
  if (one === undefined || two === undefined) throw new Error('party: two tasks');
  return [one.id, two.id];
};

export interface ChangeKit {
  since(business: BusinessId, who: Member, point: string | null): Promise<ChangesSince>;
  touch(business: BusinessId, recordIds: readonly string[]): Promise<void>;
  pointAfter(recordId: string): Promise<string>;
}

/** Bound to the suite's schedules, which `beforeAll` opens after this is called. */
export function changeKit(schedules: () => Schedules): ChangeKit {
  const since = async (
    business: BusinessId,
    who: Member,
    point: string | null,
  ): Promise<ChangesSince> => {
    const read = await schedules().db.app.withBusiness(
      business,
      async (tx) => await changesSince(tx, subjects(who), point),
    );
    if (read === 'POINT_INVALID') throw new Error('refused a point it handed out');
    return read;
  };

  const touch = async (business: BusinessId, recordIds: readonly string[]): Promise<void> => {
    await schedules().db.app.withBusiness(business, async (tx) => {
      await tx.query('update public.records set data = data where id = any($1::uuid[])', [
        recordIds,
      ]);
    });
  };

  /**
   * The point just past `recordId`'s last stamp. A point the read hands back
   * can sit lower on a shared server (another database's open transaction
   * holds the watermark), which costs duplicates, never a skip; this one is exact.
   */
  const pointAfter = async (recordId: string): Promise<string> => {
    const [row] = await schedules().db.admin.execute<{ point: string }>(
      `select (changed_xid::text::numeric + 1)::text as point
         from public.live_changes where subject_id = $1`,
      [recordId],
    );
    if (row === undefined) throw new Error('no change row to pass');
    return row.point;
  };

  return { since, touch, pointAfter };
}
