// SPDX-License-Identifier: AGPL-3.0-only
//
// Who decides a budget answer on a run's task (#796): a holder of `decide` on
// the collection for the task itself, or across the task's client (the party
// grant Access issues per client). Every money authority an answer judges asks
// this: the answer's own grant, the four-eyes pairing and the plan approver,
// each with the client read under the task lock (`readLocked`).

import {
  checkAuthority,
  type Scope,
  type Subject,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import { checkAuthorityAt } from './recovery/classifier.ts';

/** `at` is the answer's locked instant; absent, now (the fast refusal before the locks). */
export async function decidesOnTask(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: 'billing' | 'gate',
  task: { readonly task_id: string; readonly client_id: string | null },
  at?: string,
): Promise<boolean> {
  const holds = async (scope: Scope): Promise<boolean> => {
    const asked = { collection, action: 'decide' as const, scope };
    const held =
      at === undefined
        ? await checkAuthority(tx, subjects, asked)
        : await checkAuthorityAt(tx, subjects, asked, at);
    return held.ok;
  };
  if (await holds({ kind: 'record', id: task.task_id })) return true;
  return task.client_id !== null && (await holds({ kind: 'party', id: task.client_id }));
}
