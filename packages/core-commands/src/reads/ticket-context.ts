// SPDX-License-Identifier: AGPL-3.0-only
//
// Work this ticket (API-4): the ticket, its map's Destination and Decisions
// so far, what blocks it and what it blocks, its acceptance checks, its linked
// documents and its recent thread, in one call and one statement.
//
// The statement reads the live tables the writing transaction changes (the
// task records, `record_links`, `map_components`, the comment records), so a
// read after a write never shows the old state, with no ticket read model of
// its own to keep in step (a named deviation from the ticket's "ticket context
// read model", in the slice handback). What the reader may not read is left
// out afterwards and counted under `withheld`, by the read pipeline's own
// question (`mayRead`), never listed by id.

import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import type { TicketContext } from '../../../core-wire/src/index.ts';
import type { TaskSpine } from '../commands/context.ts';
import { mayRead, RECENT_COMMENTS, type Detail } from './detail.ts';

type Part = Readonly<Record<string, unknown>>;

interface Linked {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly type: string;
  readonly state: string | null;
  readonly category: string | null;
}

interface Decision {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly gist: string | null;
  readonly closedAt: string | null;
}

interface Comment {
  readonly id: string;
  readonly author: string | null;
  readonly audience: string | null;
  readonly body: string | null;
  readonly at: string | null;
}

/** The ticket's bundle as stored, before anything is withheld or projected. */
export interface TicketContextRow {
  readonly ticket: Linked & {
    readonly revision: number;
    readonly assignee: string | null;
    readonly due: string | null;
    readonly priority: number | null;
    readonly completedAt: string | null;
    readonly description: string | null;
    readonly gist: string | null;
  };
  readonly map: {
    readonly id: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly destination: string | null;
    /** The map owner's person id: the one who resolves its grilling and prototype tickets. */
    readonly owner: string | null;
    readonly decisions: readonly Decision[];
  } | null;
  readonly blockedBy: readonly Linked[];
  readonly blocks: readonly Linked[];
  readonly thread: readonly Comment[];
}

// A linked task as JSON: its id, names, type and state. `$side` is the column
// of `record_links` that names the other task, which must be a task: a link to
// a record of another type is never shown under a task grant.
const linked = (side: 'from_record_id' | 'to_record_id', mine: string): string => `
  coalesce((select json_agg(json_build_object(
              'id', o.id, 'key', o.txt_1, 'title', o.txt_4,
              'type', coalesce(o.data ->> 'type', 'task'),
              'state', os.data ->> 'label', 'category', os.data ->> 'machine_category')
              order by l.id)
       from public.record_links l
       join public.records o on o.business_id = l.business_id and o.id = l.${side}
       left join public.records os on os.business_id = o.business_id and os.id = o.uuid_1
      where l.business_id = t.business_id and l.${mine} = t.id and l.link_type = 'blocks'
        and o.record_type_id = t.record_type_id and o.deleted_at is null), '[]'::json)`;

const STATEMENT = `
  select json_build_object(
           'id', t.id, 'key', t.txt_1, 'title', t.txt_4,
           'type', coalesce(t.data ->> 'type', 'task'),
           'state', ts.data ->> 'label', 'category', ts.data ->> 'machine_category',
           'revision', t.revision, 'assignee', p.display_name, 'due', t.ts_1,
           'priority', t.num_1, 'completedAt', t.ts_2,
           'description', t.data ->> 'description', 'gist', t.data ->> 'gist') as ticket,
         (select json_build_object(
                   'id', m.id, 'key', m.txt_1, 'title', m.txt_4,
                   'owner', m.data ->> 'map_owner',
                   'destination', (select c.body from public.map_components c
                                    where c.business_id = m.business_id and c.map_id = m.id
                                      and c.kind = 'destination' and c.retired_version is null
                                    order by c.position limit 1),
                   'decisions', coalesce((select json_agg(json_build_object(
                                  'id', d.id, 'key', d.txt_1, 'title', d.txt_4,
                                  'gist', d.data ->> 'gist', 'closedAt', d.ts_2)
                                  order by d.ts_2 nulls first, d.id)
                       from public.records d
                       join public.records ds on ds.business_id = d.business_id and ds.id = d.uuid_1
                      where d.business_id = m.business_id and d.uuid_4 = m.id
                        and d.record_type_id = m.record_type_id and d.deleted_at is null
                        and ds.data ->> 'machine_category' = 'completed'
                        and d.data ->> 'closed_as' is distinct from 'out_of_scope'), '[]'::json))
            from public.records m
           where m.business_id = t.business_id and m.id = t.uuid_4
             and m.record_type_id = t.record_type_id and m.deleted_at is null
             and m.data ->> 'type' = 'map') as map,
         ${linked('from_record_id', 'to_record_id')} as "blockedBy",
         ${linked('to_record_id', 'from_record_id')} as blocks,
         coalesce((select json_agg(json_build_object(
                     'id', c.id, 'author', c.data ->> 'author', 'audience', c.data ->> 'audience',
                     'body', c.data ->> 'body', 'at', c.data ->> 'posted_at')
                     order by c.data ->> 'posted_at', c.id)
             from public.records c
            where c.business_id = t.business_id and c.record_type_id = $4
              and c.deleted_at is null and c.data ->> 'task' = t.id::text), '[]'::json) as thread
    from public.records t
    left join public.records ts on ts.business_id = t.business_id and ts.id = t.uuid_1
    left join public.people p on p.business_id = t.business_id and p.id = t.uuid_2
   where t.business_id = $1 and t.record_type_id = $2 and t.id = $3 and t.deleted_at is null`;

/** The bundle as stored, in one statement, or undefined when the id names no live task here. */
export async function readTicketContext(
  tx: TenantQuery,
  spine: TaskSpine,
  recordId: string,
): Promise<TicketContextRow | undefined> {
  const rows = await tx.query<TicketContextRow>(STATEMENT, [
    tx.businessId,
    spine.taskTypeId,
    recordId,
    spine.taskCommentTypeId ?? null,
  ]);
  return rows[0];
}

/** The tasks `subjects` may read, and how many they may not. */
async function readable(
  tx: TenantQuery,
  subjects: readonly Subject[],
  tasks: readonly Linked[],
): Promise<{ readonly shown: readonly Linked[]; readonly withheld: number }> {
  const shown: Linked[] = [];
  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop -- one grant check per task, on one transaction
    if (subjects.length > 0 && (await mayRead(tx, subjects, task.id))) shown.push(task);
  }
  return { shown, withheld: tasks.length - shown.length };
}

/** Checklist lines of the description (`- [ ]`, `- [x]`), as written. */
export function acceptanceOf(description: string | null): readonly string[] {
  return (description ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*] \[[ xX]\] /u.test(line));
}

const named = (task: { readonly id: string; readonly key: string | null }): Part =>
  task.key === null ? { id: task.id } : { key: task.key };

function linkedAt(detail: Detail, task: Linked): Part {
  if (detail === 'full') return { ...task };
  if (detail === 'brief') return named(task);
  const { id: _id, key: _key, ...rest } = task;
  return { ...named(task), ...rest };
}

function ticketAt(detail: Detail, ticket: TicketContextRow['ticket']): Part {
  const { id, key, title, type, state } = ticket;
  if (detail === 'brief') return { id, key, title, type, state };
  return { ...ticket };
}

function mapAt(
  detail: Detail,
  map: NonNullable<TicketContextRow['map']>,
): NonNullable<TicketContext['map']> {
  const decisions = map.decisions.map((line): Part => {
    if (detail === 'full') return { ...line };
    return detail === 'brief'
      ? named(line)
      : { ...named(line), title: line.title, gist: line.gist };
  });
  if (detail === 'brief') return { key: map.key, title: map.title, decisions };
  const { id, decisions: _all, ...rest } = map;
  return { ...(detail === 'full' ? { id } : {}), ...rest, decisions };
}

function threadAt(detail: Detail, thread: readonly Comment[]): readonly Part[] {
  if (detail === 'brief') return [];
  if (detail === 'full') return thread.map((comment) => ({ ...comment }));
  return thread.slice(-RECENT_COMMENTS).map(({ id: _id, ...rest }) => rest);
}

/**
 * The bundle a reader is shown at a level: the map only where it may read the
 * map, the tickets around it only where it may read each, the rest counted
 * under `withheld`. A level is a projection of the same row, never a wider read.
 */
export async function contextFor(
  tx: TenantQuery,
  subjects: readonly Subject[],
  row: TicketContextRow,
  detail: Detail,
): Promise<TicketContext> {
  const map = row.map !== null && subjects.length > 0 && (await mayRead(tx, subjects, row.map.id));
  const blockedBy = await readable(tx, subjects, row.blockedBy);
  const blocks = await readable(tx, subjects, row.blocks);
  const withheld = {
    ...(row.map !== null && !map ? { map: 1 } : {}),
    ...(blockedBy.withheld > 0 ? { blockedBy: blockedBy.withheld } : {}),
    ...(blocks.withheld > 0 ? { blocks: blocks.withheld } : {}),
  };
  return {
    ticket: ticketAt(detail, row.ticket),
    ...(map && row.map !== null ? { map: mapAt(detail, row.map) } : {}),
    blockedBy: blockedBy.shown.map((task) => linkedAt(detail, task)),
    blocks: blocks.shown.map((task) => linkedAt(detail, task)),
    acceptance: acceptanceOf(row.ticket.description),
    documents: [],
    thread: threadAt(detail, row.thread),
    threadCount: row.thread.length,
    ...(Object.keys(withheld).length > 0 ? { withheld } : {}),
  };
}
