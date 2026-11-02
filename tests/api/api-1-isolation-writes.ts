// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, the record writes in the delegation crossing
// (api-1-isolation-delegation.ts): each command's body on a record the crossing
// names, and the rows a refused write must not leave. Made-up values only.

import { randomUUID } from 'node:crypto';
import { fixture } from './api-1-isolation-world.ts';

/** A field write on `record`, at a revision the crossing never reaches. */
const written = (record: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  recordId: record,
  expectedRevision: 1,
  fields,
});

/**
 * An agent writes its own task's fields under a delegation (MP-4-7, MP-4-8): never
 * another person's task, another client's or another business's.
 */
export const FIELD_WRITES: Record<string, (record: string) => Record<string, unknown>> = {
  'task.update': (record) => written(record, { title: 'made-up' }),
  'task.assign': (record) => written(record, { assignee: randomUUID() }),
  'task.set_adhoc': (record) => written(record, { ad_hoc: true }),
  'task.set_category': (record) => written(record, { category: 'seo' }),
  'task.set_scores': (record) => written(record, { impact: 7, confidence: 9, ease: 8 }),
  'task.edit_comment': (record) => ({
    recordId: record,
    expectedRevision: 1,
    commentId: randomUUID(),
    body: 'made-up',
  }),
  'task.delete_comment': (record) => ({
    recordId: record,
    expectedRevision: 1,
    commentId: randomUUID(),
  }),
  // An agent asks to delete its own task (#2351): never another person's, client's or business's.
  'task.request_delete': (record) => ({ recordId: record, reason: 'made-up' }),
};

/** How many delete requests exist on `tasks`, in any business. */
export async function deleteRequestsOn(tasks: readonly string[]): Promise<number> {
  const rows = await fixture.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from public.task_delete_requests where task_id = any($1::uuid[])`,
    [tasks],
  );
  return rows[0]?.n ?? -1;
}
