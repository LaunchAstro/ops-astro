// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed's Wayfinder map. The map page's four views
// (P20: map, tickets, frontier, fog) draw from `map.view` and `map.frontier`,
// so the seeded map is read back through those two reads, as Ada and as two
// readers who must see none of it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import type {
  MapFrontierResult,
  MapView,
  MapViewResult,
} from '../../packages/core-wire/src/index.ts';
import {
  ada,
  businessOf,
  closeWorld,
  openWorld,
  person,
  serverUrl,
  taskId,
  type World,
} from './click-through-seed.fixture.ts';

const MAP = 'Plan the new agency website';
const RESEARCH = 'Choose the enquiry form';
const COPY = 'Draft the home page copy';
const BUILD = 'Build the enquiry page';
const GRILL = 'Settle the launch date';
const PROTOTYPE = 'Try a shorter menu';

let world: World;

async function read<T>(
  who: VerifiedSubject,
  business: string,
  request: { readonly read: string; readonly recordId: string },
): Promise<T | 'refused'> {
  const answer = await executeRead(world.db.app, business as BusinessId, who, request as never);
  return isCommandRefusal(answer) ? 'refused' : (answer as T);
}

async function adaMap(): Promise<MapView> {
  const answer = await read<MapViewResult>(ada(world), world.business, {
    read: 'map.view',
    recordId: await taskId(world, MAP),
  });
  if (answer === 'refused') throw new Error('map.view refused Ada');
  return answer.map;
}

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed map', () => {
  beforeAll(async () => {
    world = await openWorld();
    expect(world.first.status, world.first.out).toBe(0);
  }, 600_000);

  afterAll(async () => {
    await closeWorld(world);
  });

  mapCases();
  readerCases();
  guardCases();
});

function mapCases() {
  it('charts one map with its destination, notes, fog and out of scope', async () => {
    const map = await adaMap();
    expect(map.title).toBe(MAP);
    expect(map.destination?.text).toMatch(/enquiry/u);
    expect(map.notes?.text).not.toBe('');
    expect(map.fog.map((patch) => patch.text)).toHaveLength(2);
    expect(map.outOfScope.map((item) => item.text)).toEqual(['A booking system']);
    // Made-up work of the business's own: no client is named.
    expect(map.clientSet).toBe(false);
  });

  it('files five typed tickets that block one another', async () => {
    const map = await adaMap();
    const byTitle = new Map(map.tickets.map((ticket) => [ticket.title, ticket]));
    expect(
      [...byTitle.entries()].map(([title, ticket]) => [title, ticket.type]).toSorted(),
    ).toEqual(
      [
        [RESEARCH, 'research'],
        [COPY, 'task'],
        [BUILD, 'build'],
        [GRILL, 'grilling'],
        [PROTOTYPE, 'prototype'],
      ].toSorted(),
    );
    const id = (title: string) => byTitle.get(title)?.id;
    expect(byTitle.get(GRILL)?.blockedBy.toSorted()).toEqual([id(COPY), id(BUILD)].toSorted());
    expect(byTitle.get(COPY)?.blockedBy).toEqual([id(RESEARCH)]);
  });

  it('resolves one ticket into Decisions so far', async () => {
    const map = await adaMap();
    expect(map.decisions.map((decision) => [decision.title, decision.gist])).toEqual([
      [RESEARCH, 'Keep the form the agency already uses.'],
    ]);
  });
}

function readerCases() {
  it('leaves a frontier of the open, unblocked, unclaimed tickets, and the fog', async () => {
    const answer = await read<MapFrontierResult>(ada(world), world.business, {
      read: 'map.frontier',
      recordId: await taskId(world, MAP),
    });
    if (answer === 'refused') throw new Error('map.frontier refused Ada');
    // The research ticket is resolved, the build ticket claimed, the grilling blocked.
    expect(answer.frontier.map((ticket) => ticket.title).toSorted()).toEqual(
      [COPY, PROTOTYPE].toSorted(),
    );
    expect(answer.fog).toHaveLength(2);
  });

  it('refuses the map to Bea of bravo, in bravo and in alpha, and to Noah, who holds no grant', async () => {
    const recordId = await taskId(world, MAP);
    const bravo = await businessOf(world.db, 'bravo');
    const bea = person(world, 'bea@bravo.local');
    const noah = person(world, 'noah@alpha.local');
    const readers = [
      [bea, bravo],
      [bea, world.business],
      [noah, world.business],
    ] as const;
    const answers = await Promise.all(
      ['map.view', 'map.frontier'].flatMap((name) =>
        readers.map(([who, business]) => read(who, business, { read: name, recordId })),
      ),
    );
    expect(answers).toEqual(Array.from({ length: 6 }, () => 'refused'));
  });
}

const READ_MODEL_FUNCTIONS = [
  'map_summary_refresh',
  'map_summary_on_record',
  'map_summary_on_map_part',
  'map_summary_on_link',
];

function guardCases() {
  it('moves the read models without a made-up guard entry, so the seed runs again', async () => {
    expect(world.guards[1]['ledger']).toEqual([]);
    expect(world.second.status, world.second.out).toBe(0);
    const [moved] = await world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.map_frontier where map_id = $1`,
      [await taskId(world, MAP)],
    );
    expect(moved?.n).toBe(2);
  });

  it('runs the four map read-model functions as a role that is no owner and passes no row security', async () => {
    const owners = await world.db.admin.execute<{
      fn: string;
      definer: boolean;
      owner: string;
      past: boolean;
    }>(
      `select p.proname as fn, p.prosecdef as definer, r.rolname as owner,
              r.rolsuper or r.rolbypassrls or r.rolcanlogin
                or pg_has_role(r.oid, d.datdba, 'member') as past
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
         join pg_database d on d.datname = current_database()
        where n.nspname = 'public' and p.proname = any($1) order by 1`,
      [READ_MODEL_FUNCTIONS],
    );
    expect(owners.map((row) => [row.fn, row.definer, row.owner, row.past])).toEqual(
      READ_MODEL_FUNCTIONS.toSorted().map((fn) => [fn, true, 'ops_astro_map_path', false]),
    );
  });
}
