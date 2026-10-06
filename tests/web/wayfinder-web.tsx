// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder screens' world (WF-3 and WF-4): the agent CLI's world, with a
// browser client per person whose every call goes through the composed API
// and the same envelopes the routes call. A screen mounted over it reads and
// writes the real database; nothing stands in for the server.

import type { Hono } from 'hono';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { tokenFor } from '../api/fixture.ts';
import { asBrowser } from '../support/sign-in.ts';
import { addClient, type Member } from '../commands/fixture.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { until } from './screen-until.tsx';

// The wait lives beside it in screen-until.tsx; the wayfinder tests still take it from here.
export { until };
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import { must } from '../wayfinder/world.ts';
import type { CliWorld } from '../cli/api-3-world.ts';

/** A signed-in browser for `member`, on `businessKey`'s prefix. */
export async function browserFor(
  api: Hono,
  member: Member,
  businessKey: string,
): Promise<OperationsClient> {
  return new OperationsClient({
    origin: 'http://api.test',
    businessKey,
    signedIn: true,
    fetch: asBrowser(
      await tokenFor(member.presented.subject),
      async (url, init) => await api.fetch(new Request(url, init)),
    ),
  });
}

/** A charted map: its id and key, and each ticket's id by the ref it was charted with. */
export interface Charted {
  readonly map: string;
  readonly key: string;
  readonly tickets: Readonly<Record<string, string>>;
}

/** The key the business gave a record, read back as the page would address it. */
export async function keyOf(w: CliWorld, id: string): Promise<string> {
  const [row] = await w.db.admin.execute<{ readonly key: string }>(
    `select txt_1 as key from public.records where business_id = $1 and id = $2`,
    [w.business, id],
  );
  return row?.key as string;
}

/** Chart a map through `map.chart`, as `member`. */
export async function chart(
  w: CliWorld,
  member: Member,
  title: string,
  tickets: readonly Readonly<Record<string, unknown>>[],
  fog: readonly string[] = [],
): Promise<Charted> {
  const answer = await w.as(member, {
    command: 'map.chart',
    title,
    destination: `${title} destination`,
    tickets,
    fog,
  });
  const map = must(answer, 'map.chart').id;
  const made = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets;
  return { map, key: await keyOf(w, map), tickets: made ?? {} };
}

/**
 * A map scoped to a new client of this business, then given one ticket, a
 * destination and its fog. Scoped first: a ticket or a revision is content,
 * and a map with content is CLIENT_LOCKED (S0-5), so the map is filed empty.
 * The member needs `share`, which a client change is asked under.
 */
export async function scopedMap(
  w: CliWorld,
  member: Member,
  title: string,
  ticketTitle: string,
  fog: readonly string[] = [],
): Promise<Charted> {
  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const map = (await w.create(member, { title }, { taskType: 'map' })).id;
  const client = crypto.randomUUID();
  await addClient(w.db.app, w.business, client, member);
  must(await w.as(member, { command: 'map.scope', ...(await at(map)), client }), 'map.scope');
  const ticket = await w.create(
    member,
    { title: ticketTitle },
    { taskType: 'task', parentId: map },
  );
  const body = { destination: `${title} destination`, ...(fog.length > 0 ? { addFog: fog } : {}) };
  must(await w.as(member, { command: 'map.revise', ...(await at(map)), ...body }), 'map.revise');
  return { map, key: await keyOf(w, map), tickets: { t: ticket.id } };
}

/** Open the map screen for `member`, and wait for the map or its refusal. */
export async function openMap(
  w: CliWorld,
  opened: Mounted[],
  member: Member,
  mapKey: string,
  businessKey = w.key,
): Promise<Mounted> {
  const client = await browserFor(w.api, member, businessKey);
  const mounted = await mount(
    <MapScreen client={client} grantKey={member.presented.subject} mapKey={mapKey} />,
  );
  opened.push(mounted);
  await until(
    mounted,
    () =>
      mounted.find('[data-map-section="destination"]') !== null ||
      mounted.find('[data-map-refused]') !== null,
    'the map or its refusal',
  );
  return mounted;
}
