// SPDX-License-Identifier: AGPL-3.0-only
//
// The tag store (MP-4-11, CS-4.19 to CS-4.21; migration 0081).
//
// A tag is a name in the business's vocabulary; a task carries any of them
// once. Every statement here is filtered by the business the session set, on
// top of the tables' forced row security, so an identifier from another
// business is a tag or a task that is not here.
//
// **One name per business, whatever its case**, is the database's rule: the
// create inserts `on conflict do nothing` against the lower-cased index, so
// two creates of one name at once leave one tag and the other is told the
// name is taken. Adding a tag a task already carries is answered the same
// way, from the task and tag key.
//
// Who may do any of this is the commands' question (`tag:write`,
// `task:write`); this store is told the actor and trusts it.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';

export interface Tag {
  readonly id: string;
  readonly name: string;
}

/** The longest tag name 0081 keeps. */
export const TAG_NAME_LIMIT = 40;

/**
 * The name a person meant: trimmed, 1 to 40 characters, no control
 * character. Anything else is undefined, never a guess.
 */
export function tagNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  if (name.length === 0 || name.length > TAG_NAME_LIMIT || /[\u0000-\u001F\u007F]/u.test(name)) {
    return undefined;
  }
  return name;
}

export async function createTag(
  tx: TenantQuery,
  input: { readonly name: string; readonly actorId: string },
): Promise<{ readonly kind: 'created'; readonly tag: Tag } | { readonly kind: 'taken' }> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.tags (business_id, id, name, actor_id) values ($1, $2, $3, $4)
     on conflict (business_id, lower(name)) do nothing
     returning id`,
    [tx.businessId, randomUUID(), input.name, input.actorId],
  );
  const row = rows[0];
  return row === undefined
    ? { kind: 'taken' }
    : { kind: 'created', tag: { id: row.id, name: input.name } };
}

/** The business's vocabulary, by name. */
export async function listTags(tx: TenantQuery): Promise<readonly Tag[]> {
  return await tx.query<Tag>(
    `select id, name from public.tags where business_id = $1 order by lower(name), id`,
    [tx.businessId],
  );
}

/** The tags one task carries, by name. */
export async function tagsOfTask(tx: TenantQuery, taskId: string): Promise<readonly Tag[]> {
  if (!isUuid(taskId)) return [];
  return await tx.query<Tag>(
    `select g.id, g.name from public.task_tags t
       join public.tags g on g.business_id = t.business_id and g.id = t.tag_id
      where t.business_id = $1 and t.task_id = $2::uuid
      order by lower(g.name), g.id`,
    [tx.businessId, taskId],
  );
}

/** Tags carried by the admitted tasks, in each task's canonical name order. */
export async function tagsOfTasks(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, readonly Tag[]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx.query<Tag & { readonly task_id: string }>(
    `select t.task_id::text, g.id, g.name from public.task_tags t
       join public.tags g on g.business_id = t.business_id and g.id = t.tag_id
      where t.business_id = $1 and t.task_id = any($2::uuid[])
      order by lower(g.name), g.id`,
    [tx.businessId, taskIds],
  );
  const tasks = new Map<string, Tag[]>();
  for (const row of rows) {
    const tags = tasks.get(row.task_id) ?? [];
    tags.push({ id: row.id, name: row.name });
    tasks.set(row.task_id, tags);
  }
  return tasks;
}

/**
 * A live task of this business carrying the id, and a tag of its vocabulary.
 *
 * The task is read `for share`, held to the end of the transaction: a trash
 * or purge holding the row makes this wait, and once it commits the row is
 * read again, deleted, so the tag never lands on a task that is gone. The
 * key lock a plain insert takes does not wait for a trash's update.
 */
async function bothHere(
  tx: TenantQuery,
  taskId: string,
  tagId: string,
): Promise<'task' | 'tag' | undefined> {
  if (!isUuid(taskId)) return 'task';
  if (!isUuid(tagId)) return 'tag';
  const task = await tx.query<{ readonly id: string }>(
    `select r.id from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $2::uuid and r.deleted_at is null and t.key = 'task'
      for share of r`,
    [tx.businessId, taskId],
  );
  if (task.length === 0) return 'task';
  const tag = await tx.query<{ readonly id: string }>(
    `select id from public.tags where business_id = $1 and id = $2::uuid`,
    [tx.businessId, tagId],
  );
  return tag.length === 0 ? 'tag' : undefined;
}

export async function addTaskTag(
  tx: TenantQuery,
  input: { readonly taskId: string; readonly tagId: string; readonly actorId: string },
): Promise<'added' | 'carried' | 'no-task' | 'no-tag'> {
  const missing = await bothHere(tx, input.taskId, input.tagId);
  if (missing !== undefined) return missing === 'task' ? 'no-task' : 'no-tag';
  const rows = await tx.query<{ readonly tag_id: string }>(
    `insert into public.task_tags (business_id, task_id, tag_id, actor_id)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning tag_id`,
    [tx.businessId, input.taskId, input.tagId, input.actorId],
  );
  return rows.length === 0 ? 'carried' : 'added';
}

export async function removeTaskTag(
  tx: TenantQuery,
  input: { readonly taskId: string; readonly tagId: string },
): Promise<'removed' | 'no-task' | 'not-carried'> {
  const missing = await bothHere(tx, input.taskId, input.tagId);
  if (missing === 'task') return 'no-task';
  if (missing === 'tag') return 'not-carried';
  const rows = await tx.query<{ readonly tag_id: string }>(
    `delete from public.task_tags where business_id = $1 and task_id = $2 and tag_id = $3
     returning tag_id`,
    [tx.businessId, input.taskId, input.tagId],
  );
  return rows.length === 0 ? 'not-carried' : 'removed';
}
