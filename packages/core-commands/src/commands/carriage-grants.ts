// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's grants a carried call's judgement holds (`carriage-origin.ts`):
// their conversation grants and, for a page or a history source (#1666),
// their task grants, both for share without waiting, so contention refuses
// and nothing is sent. Each task's read is then judged at the locked instant,
// through a task grant held here, so a revocation of the read commits before
// it or waits. The tasks themselves are held for share, page first, then the
// sources in id order: none gone, none a client's.

import {
  slotOf,
  subjectsOf,
  TASK_SPINE,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { checkAuthorityAt, holdCoveringGrants } from '../../../core-runtime/src/index.ts';

export interface HeldGrants {
  readonly conversation: ReadonlySet<string>;
  readonly task: ReadonlySet<string>;
}

/** The conversation grants, then, where a task is read (a page or a source), the task grants, held `nowait`. */
export async function holdGrants(
  tx: TenantQuery,
  session: Session,
  readsTask: boolean,
): Promise<HeldGrants> {
  const subjects = subjectsOf(session);
  const conversation = await holdCoveringGrants(tx, subjects, 'conversation', 'nowait');
  const task = readsTask ? await holdCoveringGrants(tx, subjects, 'task', 'nowait') : [];
  return { conversation: new Set(conversation), task: new Set(task) };
}

const CLIENT = slotOf(TASK_SPINE, 'client');

/** The tasks to judge: the page, if any, then each source in id order. */
const ordered = ([page, ...sources]: readonly (string | null)[]): readonly string[] => [
  ...(page === null || page === undefined ? [] : [page]),
  ...sources.filter((id): id is string => id !== null).toSorted(),
];

/** Each task held for share, in order: `gone` if one is not there or trashed, `client` if one is a client's. */
export async function heldTasks(
  tx: TenantQuery,
  tasks: readonly (string | null)[],
): Promise<'ok' | 'gone' | 'client'> {
  for (const task of ordered(tasks)) {
    // eslint-disable-next-line no-await-in-loop -- one lock after another, in order
    const [row] = await tx.query<{ readonly client: string | null }>(
      `select ${CLIENT} as client from public.records
        where business_id = $1 and id = $2 and deleted_at is null for share`,
      [tx.businessId, task],
    );
    if (row === undefined) return 'gone';
    if (row.client !== null) return 'client';
  }
  return 'ok';
}

/** Whether the person reads each task at `at` through a task grant held; none, yes. */
export async function readsTasks(
  tx: TenantQuery,
  session: Session,
  tasks: readonly (string | null)[],
  under: { readonly at: string; readonly held: ReadonlySet<string> },
): Promise<boolean> {
  for (const task of ordered(tasks)) {
    const scope = { kind: 'record', id: task } as const;
    const request = { collection: 'task', action: 'read', scope } as const;
    // eslint-disable-next-line no-await-in-loop -- each task, in turn
    const read = await checkAuthorityAt(tx, subjectsOf(session), request, under.at);
    if (!read.ok || !read.value.some((grant) => under.held.has(grant.id))) return false;
  }
  return true;
}
