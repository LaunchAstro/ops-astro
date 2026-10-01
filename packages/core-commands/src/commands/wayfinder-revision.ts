// SPDX-License-Identifier: AGPL-3.0-only
//
// A map's revisions (WF-1): one numbered version per revision, recording
// every component it added or retired. A replaced Destination or Notes is
// retired, not overwritten, so a version's body stays readable. WF-2's chart,
// graduation and out-of-scope close write their versions through
// `applyRevision` here too.

import { randomUUID } from 'node:crypto';
import { isUuid } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { BODY_LIMIT, invalid, notPermitted, textOk, type RequestOf } from './wayfinder.ts';
import { writePreAnswers, type PreAnswer } from './wayfinder-pre-answers.ts';

interface OutOfScopeItem {
  readonly text: string;
  readonly ticketId: string | null;
}

export interface Revision {
  readonly destination?: string;
  readonly notes?: string;
  readonly addFog: readonly string[];
  readonly addOutOfScope: readonly OutOfScopeItem[];
  readonly retire: readonly string[];
  /** Charting's cited pre-answers (WF-6), checked by the chart before it writes. */
  readonly addPreAnswers?: readonly PreAnswer[];
}

/** The operands a revision is read from: `map.revise`'s, or a chart's. */
export interface RevisionOperands {
  readonly destination?: unknown;
  readonly notes?: unknown;
  readonly addFog?: unknown;
  readonly addOutOfScope?: unknown;
  readonly retire?: unknown;
}

/** A list of up to 100 entries, each read by `item`, or undefined when the list or any entry is wrong. */
function listOperand<T>(value: unknown, item: (v: unknown) => T | null): T[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const out: T[] = [];
  for (const entry of value as readonly unknown[]) {
    const parsed = item(entry);
    if (parsed === null) return undefined;
    out.push(parsed);
  }
  return out;
}

function outOfScopeItem(v: unknown): OutOfScopeItem | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { text: line, ticketId } = v as { text?: unknown; ticketId?: unknown };
  if (!textOk(line)) return null;
  if (ticketId !== undefined && ticketId !== null && !isUuid(ticketId)) return null;
  return { text: line, ticketId: typeof ticketId === 'string' ? ticketId.toLowerCase() : null };
}

/** The revision a body asks for, or the names of the operands that are wrong. */
export function parseRevision(
  request: RevisionOperands,
  allowEmpty = false,
): Revision | readonly string[] {
  const wrong: string[] = [];
  const text = (name: 'destination' | 'notes'): string | undefined => {
    const value = request[name];
    if (value !== undefined && !textOk(value)) wrong.push(name);
    return value as string | undefined;
  };
  const list = <T>(name: string, value: unknown, item: (v: unknown) => T | null): T[] => {
    const parsed = listOperand(value, item);
    if (parsed === undefined) wrong.push(name);
    return parsed ?? [];
  };
  const destination = text('destination');
  const notes = text('notes');
  const addFog = list('addFog', request.addFog, (v) => (textOk(v) ? v : null));
  const addOutOfScope = list('addOutOfScope', request.addOutOfScope, outOfScopeItem);
  const retire = list('retire', request.retire, (v) => (isUuid(v) ? v.toLowerCase() : null));
  if (wrong.length > 0) return [...new Set(wrong)].toSorted();
  const empty =
    destination === undefined &&
    notes === undefined &&
    addFog.length + addOutOfScope.length + retire.length === 0;
  if (empty && !allowEmpty) return ['destination', 'notes', 'addFog', 'addOutOfScope', 'retire'];
  return {
    ...(destination === undefined ? {} : { destination }),
    ...(notes === undefined ? {} : { notes }),
    addFog,
    addOutOfScope,
    retire,
  };
}

async function insertComponent(
  tx: TenantQuery,
  map: string,
  version: number,
  kind: string,
  body: string,
  ticketId: string | null,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into map_components
       (business_id, id, map_id, kind, body, ticket_id, position, created_version)
     values ($1, $2, $3, $4, $5, $6,
             coalesce((select max(position) + 1 from map_components
                        where business_id = $1 and map_id = $3 and kind = $4), 0), $7)`,
    [tx.businessId, id, map, kind, body.trim(), ticketId, version],
  );
  return id;
}

async function retireComponents(
  tx: TenantQuery,
  map: string,
  version: number,
  where: { readonly ids?: readonly string[]; readonly kind?: string },
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `update map_components set retired_version = $3
      where business_id = $1 and map_id = $2 and retired_version is null
        and ($4::uuid[] is null or id = any($4::uuid[]))
        and ($5::text is null or kind = $5)
      returning id`,
    [tx.businessId, map, version, where.ids ?? null, where.kind ?? null],
  );
  return rows.map((row) => row.id);
}

/** A patch leaving the fog for the tickets it became (WF-2). */
export interface Graduation {
  readonly patchId: string;
  readonly tickets: readonly string[];
}

/** Retire and replace Destination and Notes, then add fog and out-of-scope lines: the ids written. */
async function writeComponents(
  tx: TenantQuery,
  mapId: string,
  version: number,
  parsed: Revision,
): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const kind of ['destination', 'notes'] as const) {
    const body = parsed[kind];
    if (body === undefined) continue;
    // In order: retire the current one, then write its successor.
    // oxlint-disable-next-line no-await-in-loop
    const retired = await retireComponents(tx, mapId, version, { kind });
    // oxlint-disable-next-line no-await-in-loop
    const written = await insertComponent(tx, mapId, version, kind, body, null);
    changed.push(...retired, written);
  }
  for (const line of parsed.addFog) {
    // oxlint-disable-next-line no-await-in-loop
    changed.push(await insertComponent(tx, mapId, version, 'fog', line, null));
  }
  for (const item of parsed.addOutOfScope) {
    const { text, ticketId } = item;
    // oxlint-disable-next-line no-await-in-loop
    changed.push(await insertComponent(tx, mapId, version, 'out_of_scope', text, ticketId));
  }
  return changed;
}

/**
 * Write one numbered version of a map: retire, replace and add components,
 * record which ones changed, and move the map's revision. The caller has
 * already checked every operand, and holds the map lock (`wayfinder.map`).
 */
export async function applyRevision(
  tx: TenantQuery,
  context: CommandContext,
  mapId: string,
  parsed: Revision,
  graduation?: Graduation,
): Promise<{
  readonly version: number;
  readonly changed: readonly string[];
  readonly revision: number;
}> {
  const numbered = await tx.query<{ readonly next: number }>(
    `select coalesce(max(version), 0) + 1 as next from map_versions
      where business_id = $1 and map_id = $2`,
    [tx.businessId, mapId],
  );
  const version = Number(numbered[0]?.next ?? 1);
  const changed: string[] = [
    ...(await retireComponents(tx, mapId, version, { ids: parsed.retire })),
  ];
  if (graduation !== undefined) {
    await tx.query(
      `update map_components set retired_version = $3, graduated_into = $4::uuid[]
        where business_id = $1 and id = $2`,
      [tx.businessId, graduation.patchId, version, graduation.tickets],
    );
    changed.push(graduation.patchId);
  }
  changed.push(...(await writeComponents(tx, mapId, version, parsed)));
  if (parsed.addPreAnswers !== undefined) {
    changed.push(...(await writePreAnswers(tx, mapId, version, parsed.addPreAnswers)));
  }
  await tx.query(
    `insert into map_versions (business_id, id, map_id, version, changed, actor_id)
     values ($1, $2, $3, $4, $5::uuid[], $6)`,
    [tx.businessId, randomUUID(), mapId, version, changed, context.session.actorId],
  );
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('map_version', $3::int), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, mapId, version],
  );
  return { version, changed, revision: Number(rows[0]?.revision) };
}

/** A revision's links and retirements must name this map's own tickets and current components. */
async function refuseForeignOperands(
  tx: TenantQuery,
  context: CommandContext,
  mapId: string,
  parsed: Revision,
): Promise<HandlerOutcome | undefined> {
  const linked = parsed.addOutOfScope.flatMap((item) =>
    item.ticketId === null ? [] : [item.ticketId],
  );
  if (linked.length > 0) {
    const children = await tx.query<{ readonly id: string }>(
      `select id from records
        where business_id = $1 and id = any($2::uuid[]) and uuid_4 = $3
          and record_type_id = $4`,
      [tx.businessId, linked, mapId, context.spine.taskTypeId],
    );
    if (children.length !== new Set(linked).size) {
      return refused(refuseCommand('NOT_FOUND', ['addOutOfScope'], ['Link a ticket of this map.']));
    }
  }
  if (parsed.retire.length > 0) {
    const current = await tx.query<{ readonly id: string }>(
      `select id from map_components
        where business_id = $1 and map_id = $2 and retired_version is null and id = any($3::uuid[])`,
      [tx.businessId, mapId, parsed.retire],
    );
    if (current.length !== new Set(parsed.retire).size) {
      return refused(
        refuseCommand('NOT_FOUND', ['retire'], ['Retire a current component of this map.']),
      );
    }
  }
  return undefined;
}

/** `map revised (version, components)`: one numbered version per revision. */
export async function reviseMap(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'map.revise'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('reviseMap: the envelope read no target');
  if (target.data['type'] !== 'map') {
    return notPermitted(['type'], ['Only a task of type map has components to revise.']);
  }
  const revision = parseRevision(request);
  if (Array.isArray(revision)) {
    return invalid(revision as readonly string[], [
      `Destination and notes are 1 to ${String(BODY_LIMIT)} characters.`,
      'addFog is a list of lines; addOutOfScope a list of { text, ticketId? }; retire a list of component ids.',
    ]);
  }
  const parsed = revision as Revision;
  const foreign = await refuseForeignOperands(tx, context, target.id, parsed);
  if (foreign !== undefined) return foreign;
  const written = await applyRevision(tx, context, target.id, parsed);
  return applied(target.id, written.revision, {
    version: written.version,
    changed: written.changed,
  });
}
