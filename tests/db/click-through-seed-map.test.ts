// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed's Wayfinder map. The map page's four views
// (P20: map, tickets, frontier, fog) draw from `map.view` and `map.frontier`,
// so the seeded map is read back through those two reads, as Ada and as two
// readers who must see none of it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
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
  guardState,
  openWorld,
  person,
  runSeed,
  SEED,
  serverUrl,
  snapshot,
  taskId,
  type World,
} from './click-through-seed.fixture.ts';

const MAP = 'Plan the new agency website';
const RESEARCH = 'Choose the enquiry form';
const COPY = 'Draft the home page copy';
const BUILD = 'Build the enquiry page';
const GRILL = 'Settle the launch date';
const PROTOTYPE = 'Try a shorter menu';
const NOTES = 'A made-up map for the click-through: the owner signs off the copy.';

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
  roleCases();
  // Last: it reopens the research ticket, which every case above reads resolved.
  driftCases();
});

function mapCases() {
  it('charts one map with its destination, notes, fog and out of scope', async () => {
    const map = await adaMap();
    expect(map.title).toBe(MAP);
    expect(map.destination?.text).toMatch(/enquiry/u);
    expect(map.notes?.text).toBe(NOTES);
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
}

/** Each read-model writer: how it runs, who owns it, and who may call it or become its owner. */
const FUNCTION_FACTS = `select p.proname as fn, p.prosecdef as definer, p.proconfig as config,
              r.rolname as owner, r.rolsuper or r.rolbypassrls or r.rolcanlogin as past,
              pg_has_role(r.oid, d.datdba, 'member') as owner_member,
              pg_has_role('ops_astro_app', r.oid, 'member') as application_becomes,
              has_function_privilege('public', p.oid, 'EXECUTE') as public,
              has_function_privilege('ops_astro_app', p.oid, 'EXECUTE') as application,
              has_function_privilege('ops_astro_worker', p.oid, 'EXECUTE') as worker
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
         join pg_database d on d.datname = current_database()
        where n.nspname = 'public' and p.proname = any($1) order by 1`;

function roleCases() {
  it('runs the four map read-model functions as their own pinned role, which no caller becomes or calls', async () => {
    const functions = await world.db.admin.execute<Record<string, unknown>>(FUNCTION_FACTS, [
      READ_MODEL_FUNCTIONS,
    ]);
    // Its own role: the made-up guard and row security judge its writes as the
    // application's, never the owner's; the application can neither take the
    // role nor call the writers, which only their triggers fire.
    expect(functions.map((row) => Object.assign({}, row))).toStrictEqual(
      READ_MODEL_FUNCTIONS.toSorted().map((fn) => ({
        fn,
        definer: true,
        config: ['search_path=pg_catalog, public'],
        owner: 'ops_astro_map_path',
        past: false,
        owner_member: false,
        application_becomes: false,
        public: false,
        application: false,
        worker: false,
      })),
    );
  });

  it("gives the map read models' role reads of what they count and writes to the two read models only", async () => {
    const held = await world.db.admin.execute<{ held: string }>(
      `select c.relname || ':' || string_agg(lower(a.action), ',' order by a.action) as held
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as a(action)
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and has_table_privilege('ops_astro_map_path', c.oid, a.action)
        group by c.relname order by 1`,
    );
    expect(held.map((row) => row.held)).toStrictEqual([
      'map_components:select',
      'map_frontier:delete,insert,select',
      'map_summaries:delete,insert,select,update',
      'map_versions:select',
      'record_links:select',
      'record_types:select',
      'records:select',
    ]);
  });
}

async function revisionOf(id: string): Promise<number> {
  const [row] = await world.db.admin.execute<{ revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [id],
  );
  return Number(row?.revision);
}

function driftCases() {
  it('refuses the map by name, writing nothing, once its research ticket is reopened', async () => {
    const research = await taskId(world, RESEARCH);
    const reopened = await executeCommand(world.db.app, world.business, ada(world), 'api', {
      command: 'task.reopen',
      operationId: `made-up:${randomUUID()}`,
      recordId: research,
      expectedRevision: await revisionOf(research),
      reason: 'Recheck the enquiry form',
    } as never);
    expect('code' in reopened, JSON.stringify(reopened)).toBe(false);
    expect((await adaMap()).decisions).toEqual([]);
    const was = [await snapshot(world.db), await guardState(world.db)];
    const ran = runSeed(SEED, { admin: world.db, local: world.local });
    expect(ran.status, ran.out).toBe(1);
    expect(ran.out).toMatch(/click-through-seed: REFUSED/u);
    expect(ran.out).toMatch(/'Plan the new agency website' .*reset/u);
    expect([await snapshot(world.db), await guardState(world.db)]).toEqual(was);
  });
}
