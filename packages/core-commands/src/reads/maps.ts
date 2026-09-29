// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view (WF-1): a map task's sections, its tickets, Decisions so far
// and its versions. Decisions so far is rendered here from the map's resolved
// tickets in closing order, never stored on the map, so a decision lives once,
// on its ticket (W2).

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type {
  MapComponentView,
  MapFrontierResult,
  MapStatus,
  MapView,
} from '../../../core-wire/src/index.ts';
import type { Detail } from './detail.ts';

interface MapRow {
  readonly key: string | null;
  readonly title: string | null;
  readonly owner: string | null;
  readonly client: string | null;
  readonly version: number | null;
  readonly revision: string;
}

interface ComponentRow {
  readonly id: string;
  readonly kind: MapComponentView['kind'];
  readonly body: string;
  readonly ticket_id: string | null;
}

interface TicketRow {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly type: string | null;
  readonly state: string | null;
  readonly category: string | null;
  readonly gist: string | null;
  readonly closed_at: Date | null;
}

interface VersionRow {
  readonly version: number;
  readonly changed: readonly string[];
  readonly actor_id: string;
  readonly created_at: Date;
}

function componentView(row: ComponentRow): MapComponentView {
  return { id: row.id, kind: row.kind, text: row.body, ticketId: row.ticket_id };
}

/** Decisions so far: the map's completed tickets in closing order, rendered, never stored. */
function decisionsSoFar(tickets: readonly TicketRow[]): MapView['decisions'] {
  return tickets
    .filter((ticket) => ticket.category === 'completed')
    .toSorted(
      (a, b) =>
        (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0) || a.id.localeCompare(b.id),
    )
    .map((ticket) => ({
      ticketId: ticket.id,
      key: ticket.key,
      title: ticket.title,
      gist: ticket.gist,
      closedAt: ticket.closed_at?.toISOString() ?? null,
    }));
}

function mapView(
  mapId: string,
  map: MapRow,
  components: readonly ComponentRow[],
  tickets: readonly TicketRow[],
  versions: readonly VersionRow[],
): MapView {
  const of = (kind: MapComponentView['kind']) =>
    components.filter((row) => row.kind === kind).map((row) => componentView(row));
  return {
    id: mapId,
    key: map.key,
    title: map.title,
    type: 'map',
    owner: map.owner,
    client: map.client,
    version: map.version ?? 0,
    revision: Number(map.revision),
    destination: of('destination')[0] ?? null,
    notes: of('notes')[0] ?? null,
    fog: of('fog'),
    outOfScope: of('out_of_scope'),
    decisions: decisionsSoFar(tickets),
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      type: ticket.type ?? 'task',
      state: ticket.state,
    })),
    versions: versions.map((row) => ({
      version: row.version,
      changed: row.changed,
      actorId: row.actor_id,
      at: row.created_at.toISOString(),
    })),
  };
}

async function readMapTickets(
  tx: TenantQuery,
  taskTypeId: string,
  mapId: string,
): Promise<readonly TicketRow[]> {
  return await tx.query<TicketRow>(
    `select c.id, c.txt_1 as key, c.txt_4 as title, coalesce(c.data ->> 'type', 'task') as type,
            s.data ->> 'key' as state, s.data ->> 'machine_category' as category,
            c.data ->> 'gist' as gist, c.ts_2 as closed_at
       from public.records c
       left join public.records s on s.business_id = c.business_id and s.id = c.uuid_1
      where c.business_id = $1 and c.uuid_4 = $2 and c.record_type_id = $3
        and c.deleted_at is null
      order by c.num_2 nulls last, c.created_at, c.id`,
    [tx.businessId, mapId, taskTypeId],
  );
}

/** The map, or undefined when the id names no live map of this business. */
export async function readMapView(
  tx: TenantQuery,
  taskTypeId: string,
  mapId: string,
): Promise<MapView | undefined> {
  const maps = await tx.query<MapRow>(
    `select r.txt_1 as key, r.txt_4 as title, r.data ->> 'map_owner' as owner,
            r.data ->> 'client' as client, s.version, r.revision::text as revision
       from public.records r
       left join public.map_summaries s on s.business_id = r.business_id and s.map_id = r.id
      where r.business_id = $1 and r.id = $2 and r.record_type_id = $3
        and r.deleted_at is null and r.data ->> 'type' = 'map'`,
    [tx.businessId, mapId, taskTypeId],
  );
  const map = maps[0];
  if (map === undefined) return undefined;
  const components = await tx.query<ComponentRow>(
    `select id, kind, body, ticket_id from public.map_components
      where business_id = $1 and map_id = $2 and retired_version is null
      order by kind, position`,
    [tx.businessId, mapId],
  );
  const tickets = await readMapTickets(tx, taskTypeId, mapId);
  const versions = await tx.query<VersionRow>(
    `select version, changed, actor_id, created_at from public.map_versions
      where business_id = $1 and map_id = $2 order by version`,
    [tx.businessId, mapId],
  );
  return mapView(mapId, map, components, tickets, versions);
}

/**
 * The frontier and the fog, one query each on their read models, or undefined
 * when the id names no live map here.
 */
export async function readMapFrontier(
  tx: TenantQuery,
  taskTypeId: string,
  mapId: string,
): Promise<MapFrontierResult | undefined> {
  const frontier = await tx.query<{
    readonly id: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly type: string;
  }>(
    `select f.ticket_id as id, t.txt_1 as key, t.txt_4 as title,
            coalesce(t.data ->> 'type', 'task') as type
       from public.records m
       left join public.map_frontier f on f.business_id = m.business_id and f.map_id = m.id
       left join public.records t on t.business_id = f.business_id and t.id = f.ticket_id
      where m.business_id = $1 and m.id = $2 and m.record_type_id = $3
        and m.deleted_at is null and m.data ->> 'type' = 'map'
      order by f.position`,
    [tx.businessId, mapId, taskTypeId],
  );
  if (frontier.length === 0) return undefined;
  const fog = await tx.query<{ readonly id: string; readonly body: string }>(
    `select id, body from public.map_components
      where business_id = $1 and map_id = $2 and kind = 'fog' and retired_version is null
      order by position`,
    [tx.businessId, mapId],
  );
  return {
    ok: true,
    frontier: frontier
      .filter((row) => row.id !== null)
      .map((row) => ({ id: row.id, key: row.key, title: row.title, type: row.type })),
    fog: fog.map((row) => ({ id: row.id, text: row.body })),
  };
}

interface StatusRow {
  readonly version: number;
  readonly open: number;
  readonly closed: number;
  readonly out_of_scope: number;
  readonly frontier: readonly {
    readonly id: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly type: string;
  }[];
  readonly fog: readonly { readonly id: string; readonly text: string }[];
}

/**
 * Map status (API-4): the frontier, the fog and the counts, in one statement
 * over the map's read models (the summary is WF-1's, the frontier WF-2's),
 * which the writing transaction keeps current, so a read after a write never
 * shows the old state. Undefined when the id names no live map here.
 *
 * Full carries every id; standard names a frontier ticket by its key, title
 * and type (its id only where it has no key); brief keeps the counts and the
 * keys. A level is a projection of the same row, never a second read.
 */
export async function readMapStatus(
  tx: TenantQuery,
  taskTypeId: string,
  mapId: string,
  detail: Detail,
): Promise<MapStatus | undefined> {
  const rows = await tx.query<StatusRow>(
    `select coalesce(s.version, 0) as version,
            coalesce(s.open_tickets, 0) as open,
            coalesce(s.closed_tickets, 0) as closed,
            coalesce(s.out_of_scope, 0) as out_of_scope,
            coalesce((select json_agg(json_build_object(
                        'id', f.ticket_id, 'key', t.txt_1, 'title', t.txt_4,
                        'type', coalesce(t.data ->> 'type', 'task')) order by f.position)
                        from public.map_frontier f
                        join public.records t
                          on t.business_id = f.business_id and t.id = f.ticket_id
                       where f.business_id = m.business_id and f.map_id = m.id),
                     '[]'::json) as frontier,
            coalesce((select json_agg(json_build_object('id', c.id, 'text', c.body)
                               order by c.position)
                        from public.map_components c
                       where c.business_id = m.business_id and c.map_id = m.id
                         and c.kind = 'fog' and c.retired_version is null),
                     '[]'::json) as fog
       from public.records m
       left join public.map_summaries s on s.business_id = m.business_id and s.map_id = m.id
      where m.business_id = $1 and m.id = $2 and m.record_type_id = $3
        and m.deleted_at is null and m.data ->> 'type' = 'map'`,
    [tx.businessId, mapId, taskTypeId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    map: mapId,
    version: row.version,
    open: row.open,
    closed: row.closed,
    outOfScope: row.out_of_scope,
    frontier: row.frontier.map((ticket) => frontierAt(detail, ticket)),
    fog: detail === 'brief' ? row.fog.map((line) => ({ id: line.id })) : row.fog,
  };
}

function frontierAt(
  detail: Detail,
  ticket: StatusRow['frontier'][number],
): MapStatus['frontier'][number] {
  if (detail === 'full') return { ...ticket };
  const named = ticket.key === null ? { id: ticket.id } : { key: ticket.key };
  return detail === 'brief' ? named : { ...named, title: ticket.title, type: ticket.type };
}
