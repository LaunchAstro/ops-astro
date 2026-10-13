// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's grants a carried call's judgement holds (`carriage-origin.ts`):
// their conversation grants and, for a page, their task grants, both for
// share without waiting, so contention refuses and nothing is sent. The
// page's task read is then judged at the locked instant, through a task grant
// held here, so a revocation of the read commits before it or waits.

import { subjectsOf, type Session, type TenantQuery } from '../../../core-records/src/index.ts';
import { checkAuthorityAt, holdCoveringGrants } from '../../../core-runtime/src/index.ts';

export interface HeldGrants {
  readonly conversation: ReadonlySet<string>;
  readonly task: ReadonlySet<string>;
}

/** The conversation grants, then for a page the task grants, held `nowait`. */
export async function holdGrants(
  tx: TenantQuery,
  session: Session,
  page: string | null,
): Promise<HeldGrants> {
  const subjects = subjectsOf(session);
  const conversation = await holdCoveringGrants(tx, subjects, 'conversation', 'nowait');
  const task = page === null ? [] : await holdCoveringGrants(tx, subjects, 'task', 'nowait');
  return { conversation: new Set(conversation), task: new Set(task) };
}

/** Whether the person reads the page at `at` through a task grant held; no page, yes. */
export async function readsPage(
  tx: TenantQuery,
  session: Session,
  page: string | null,
  under: { readonly at: string; readonly held: ReadonlySet<string> },
): Promise<boolean> {
  if (page === null) return true;
  const scope = { kind: 'record', id: page } as const;
  const request = { collection: 'task', action: 'read', scope } as const;
  const read = await checkAuthorityAt(tx, subjectsOf(session), request, under.at);
  return read.ok && read.value.some((grant) => under.held.has(grant.id));
}
