// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder screens' world (WF-3 to WF-5): the agent CLI's world, with a
// browser client per person whose every call goes through the composed API
// and the same envelopes the routes call. A screen mounted over it reads and
// writes the real database; nothing stands in for the server.

import { act } from 'react';
import type { Hono } from 'hono';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { tokenFor } from '../api/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
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
    token: await tokenFor(member.presented.subject),
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      await api.fetch(new Request(url, init))) as typeof fetch,
  });
}

/** Let the screen's reads and writes land, until `ready` holds or the wait runs out. */
export async function until(
  mounted: Mounted,
  ready: () => boolean,
  what: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const step = async (): Promise<void> => {
    if (ready()) return;
    if (Date.now() > deadline) {
      throw new Error(`waited for ${what}; the page says: ${mounted.text()}`);
    }
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    await step();
  };
  await step();
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
