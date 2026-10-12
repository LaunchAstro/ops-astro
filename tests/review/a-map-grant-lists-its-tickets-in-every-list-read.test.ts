// SPDX-License-Identifier: AGPL-3.0-only
//
// A `task`/`read` record grant on a map reaches each direct child of the map
// that is not itself a map. `task.read` honours that reach one ticket at a
// time; these cases hold the list reads to it: the board, search and
// attribution each list the granted map's tickets. A map filed under the
// granted map is never listed through it, nor are its own children, and the
// grant lists nothing of another business, another client's map or another
// person's map grant.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { clientHere } from '../reads/client-rows.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type Member,
  type WayfinderWorld,
} from '../wayfinder/world.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

/** The one word every title carries, so one search reaches every ticket here. */
const WORD = 'Lighthouse';
/** The instruction file every seeded run read, by its digest. */
const DIGEST = 'd'.repeat(64);

interface World {
  readonly reader: Member;
  readonly map: Made;
  readonly first: Made;
  readonly second: Made;
  readonly nested: Made;
  readonly nestedChild: Made;
  readonly otherClient: Made;
  readonly otherPerson: Made;
  readonly otherPersonReader: Member;
  readonly outsider: Member;
  readonly bravoMap: Made;
  readonly bravoTicket: Made;
  readonly runs: Readonly<Record<string, string>>;
}

const TITLES = {
  map: `${WORD} granted map`,
  first: `${WORD} first ticket`,
  second: `${WORD} second ticket`,
  nested: `${WORD} nested map CANARYNESTEDMAP`,
  nestedChild: `${WORD} nested child CANARYNESTEDCHILD`,
  otherClientMap: `${WORD} other client map CANARYCLIENTMAP`,
  otherClient: `${WORD} other client ticket CANARYCLIENTTICKET`,
  otherPersonMap: `${WORD} other person map CANARYPERSONMAP`,
  otherPerson: `${WORD} other person ticket CANARYPERSONTICKET`,
} as const;

let w: WayfinderWorld;
let owner: Decider;
let world: World;

/** A pending proposal on the task, so it has a planned run; returns the run. */
async function runOn(by: Member, task: Made, business: BusinessId = w.business): Promise<string> {
  must(
    await w.as(
      by,
      {
        command: 'task.propose',
        recordId: task.id,
        expectedRevision: await w.revisionOf(task.id, business),
        purpose: `lists_${randomUUID().slice(0, 8)}`,
        maximumMinor: 2_000,
        currency: 'AUD',
        payload: { instruction: 'draft a reply' },
        step: { kind: 'compose', payload: {} },
      },
      business,
    ),
    'propose',
  );
  const [run] = await w.db.admin.execute<{ readonly id: string }>(
    `select id from public.planned_runs where business_id = $1 and task_id = $2`,
    [business, task.id],
  );
  if (run === undefined) throw new Error('proposal planned no run');
  return run.id;
}

/** The run's pin and its entry read of the one instruction file, as the ledger keeps them. */
async function readsTheFile(runId: string, by: Member, business: BusinessId): Promise<void> {
  await w.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', 'skills/lists.md', $3, 10, now(), '[]'::jsonb, $3, $4)`,
    [business, runId, DIGEST, by.actorId],
  );
  await w.db.admin.execute(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     values ($1, $2, $3, 1, 'skills/lists.md', $4, 10, true)`,
    [business, randomUUID(), runId, DIGEST],
  );
}

async function scoped(map: Made, client: string): Promise<void> {
  must(
    await w.as(owner, {
      command: 'map.scope',
      recordId: map.id,
      expectedRevision: await w.revisionOf(map.id),
      client: await clientHere(w.db.admin, w.business, client),
    }),
    'map.scope',
  );
}

/** The granted map: two tickets, and a map filed under it with a child of its own. */
async function grantedMap() {
  const map = await w.create(owner, { title: TITLES.map }, { taskType: 'map' });
  await scoped(map, randomUUID());
  const under = { parentId: map.id };
  const first = await w.create(owner, { title: TITLES.first }, under);
  const second = await w.create(owner, { title: TITLES.second }, under);
  const nested = await w.create(owner, { title: TITLES.nested }, { taskType: 'map', ...under });
  const nestedChild = await w.create(owner, { title: TITLES.nestedChild }, { parentId: nested.id });
  const reader = await w.member('Map reader', ['read'], { kind: 'record', id: map.id });
  return { reader, map, first, second, nested, nestedChild };
}

/** Another client's map, another person's map grant, and another business's map. */
async function crossings() {
  const clientMap = await w.create(owner, { title: TITLES.otherClientMap }, { taskType: 'map' });
  await scoped(clientMap, randomUUID());
  const otherClient = await w.create(
    owner,
    { title: TITLES.otherClient },
    {
      parentId: clientMap.id,
    },
  );
  const personMap = await w.create(owner, { title: TITLES.otherPersonMap }, { taskType: 'map' });
  const otherPerson = await w.create(
    owner,
    { title: TITLES.otherPerson },
    {
      parentId: personMap.id,
    },
  );
  const otherPersonReader = await w.member('Other map reader', ['read'], {
    kind: 'record',
    id: personMap.id,
  });
  const outsider = await w.outsider('Bravo map owner');
  const bravoMap = await w.create(outsider, { title: TITLES.map }, { taskType: 'map' }, w.bravo);
  const bravoTicket = await w.create(
    outsider,
    { title: TITLES.first },
    {
      parentId: bravoMap.id,
    },
    w.bravo,
  );
  return { otherClient, otherPerson, otherPersonReader, outsider, bravoMap, bravoTicket };
}

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('maplists', 'maplists');
  owner = await w.decider('List owner');
  await w.grant(owner, 'share');
  const granted = await grantedMap();
  const crossed = await crossings();
  const { first, nestedChild } = granted;
  const { otherClient, otherPerson, outsider, bravoTicket } = crossed;
  const runs: Record<string, string> = {};
  for (const [name, task] of Object.entries({ first, nestedChild, otherClient, otherPerson })) {
    // eslint-disable-next-line no-await-in-loop -- one pool, one proposal at a time
    runs[name] = await runOn(owner, task);
    // eslint-disable-next-line no-await-in-loop
    await readsTheFile(runs[name] ?? '', owner, w.business);
  }
  runs['bravo'] = await runOn(outsider, bravoTicket, w.bravo);
  await readsTheFile(runs['bravo'], outsider, w.bravo);
  world = { ...granted, ...crossed, runs };
}, 180_000);
afterAll(async () => await w?.drop());

const board = async (member: Member, business: BusinessId = w.business) =>
  (await w.read(member, { read: 'task.board', board: null }, business)) as {
    readonly tasks?: readonly { readonly id: string }[];
  };

const search = async (member: Member, business: BusinessId = w.business) =>
  (await w.read(member, { read: 'task.search', query: WORD }, business)) as {
    readonly hits?: readonly { readonly id: string }[];
  };

const attribution = async (member: Member, business: BusinessId = w.business) =>
  (await w.read(member, { read: 'definition.attribution', digest: DIGEST }, business)) as {
    readonly attribution?: { readonly runs: readonly { readonly taskId: string }[] };
  };

const boardIds = async (member: Member, business?: BusinessId) =>
  ((await board(member, business)).tasks ?? []).map((row) => row.id);
const searchIds = async (member: Member, business?: BusinessId) =>
  ((await search(member, business)).hits ?? []).map((hit) => hit.id);
const attributedTasks = async (member: Member, business?: BusinessId) =>
  ((await attribution(member, business)).attribution?.runs ?? []).map((run) => run.taskId);

/** Every list read's whole body, for one member. */
const everyBody = async (member: Member): Promise<string> =>
  JSON.stringify([await board(member), await search(member), await attribution(member)]);

it("a map-only reader's board lists the map's tickets", async () => {
  const { reader, first, second } = world;
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: first.id }))).toBe('applied');
  expect(await boardIds(reader)).toEqual(expect.arrayContaining([first.id, second.id]));
}, 30_000);

it("search finds a ticket through its map's grant", async () => {
  const { reader, first, second } = world;
  expect(await searchIds(reader)).toEqual(expect.arrayContaining([first.id, second.id]));
}, 30_000);

it("attribution names runs on a map's ticket", async () => {
  const { reader, first } = world;
  expect(await attributedTasks(reader)).toContain(first.id);
}, 30_000);

it('a nested map is never listed through its parent map', async () => {
  const { reader, nested, nestedChild } = world;
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: nested.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: nestedChild.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  // The nested map and its child are real: the owner's lists show both.
  expect(await boardIds(owner)).toEqual(expect.arrayContaining([nested.id, nestedChild.id]));
  expect(await searchIds(owner)).toEqual(expect.arrayContaining([nested.id, nestedChild.id]));
  expect(await attributedTasks(owner)).toContain(nestedChild.id);
  const body = await everyBody(reader);
  for (const foreign of [
    nested.id,
    nestedChild.id,
    world.runs['nestedChild'] ?? '',
    'CANARYNESTEDMAP',
    'CANARYNESTEDCHILD',
  ]) {
    expect(body, foreign).not.toContain(foreign);
  }
}, 30_000);

it('a map grant lists nothing across a business, a client or a person', async () => {
  const { reader, otherClient, otherPerson, otherPersonReader, outsider } = world;
  const { bravoMap, bravoTicket } = world;
  // Another business: a map and ticket of the same titles, and a run reading the same file.
  expect(await boardIds(outsider, w.bravo)).toEqual(
    expect.arrayContaining([bravoMap.id, bravoTicket.id]),
  );
  expect(await searchIds(outsider, w.bravo)).toContain(bravoTicket.id);
  expect(await attributedTasks(outsider, w.bravo)).toContain(bravoTicket.id);
  // Another client's map in the same business: its ticket is real and listed to the owner.
  expect(await boardIds(owner)).toContain(otherClient.id);
  expect(await searchIds(owner)).toContain(otherClient.id);
  expect(await attributedTasks(owner)).toContain(otherClient.id);
  // Another person's map grant reaches its ticket, for that person.
  expect(
    codeOf(await w.read(otherPersonReader, { read: 'task.read', recordId: otherPerson.id })),
  ).toBe('applied');
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: otherPerson.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  const body = await everyBody(reader);
  for (const foreign of [
    bravoMap.id,
    bravoTicket.id,
    world.runs['bravo'] ?? '',
    otherClient.id,
    world.runs['otherClient'] ?? '',
    'CANARYCLIENTMAP',
    'CANARYCLIENTTICKET',
    otherPerson.id,
    world.runs['otherPerson'] ?? '',
    'CANARYPERSONMAP',
    'CANARYPERSONTICKET',
  ]) {
    expect(body, foreign).not.toContain(foreign);
  }
}, 30_000);
