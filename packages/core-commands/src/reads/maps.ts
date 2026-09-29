// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view (WF-1): a map task's sections, its tickets, Decisions so far
// and its versions. Decisions so far is rendered here from the map's resolved
// tickets in closing order, never stored on the map, so a decision lives once,
// on its ticket (W2).

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { MapComponentView, MapView } from '../../../core-wire/src/index.ts';

interface MapRow {
  readonly key: string | null;
  readonly title: string | null;
  readonly owner: string | null;
  readonly client: string | null;
  readonly version: number | null;
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

/** The map, or undefined when the id names no live map of this business. */
export async function readMapView(
  tx: TenantQuery,
  taskTypeId: string,
  mapId: string,
): Promise<MapView | undefined> {
  const maps = await tx.query<MapRow>(
    `select r.txt_1 as key, r.txt_4 as title, r.data ->> 'map_owner' as owner,
            r.data ->> 'client' as client, s.version
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
  const tickets = await tx.query<TicketRow>(
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
  const versions = await tx.query<VersionRow>(
    `select version, changed, actor_id, created_at from public.map_versions
      where business_id = $1 and map_id = $2 order by version`,
    [tx.businessId, mapId],
  );

  const of = (kind: MapComponentView['kind']) =>
    components.filter((row) => row.kind === kind).map((row) => componentView(row));
  const closed = tickets
    .filter((ticket) => ticket.category === 'completed')
    .toSorted(
      (a, b) =>
        (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0) || a.id.localeCompare(b.id),
    );

  return {
    id: mapId,
    key: map.key,
    title: map.title,
    type: 'map',
    owner: map.owner,
    client: map.client,
    version: map.version ?? 0,
    destination: of('destination')[0] ?? null,
    notes: of('notes')[0] ?? null,
    fog: of('fog'),
    outOfScope: of('out_of_scope'),
    decisions: closed.map((ticket) => ({
      ticketId: ticket.id,
      key: ticket.key,
      title: ticket.title,
      gist: ticket.gist,
      closedAt: ticket.closed_at?.toISOString() ?? null,
    })),
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
