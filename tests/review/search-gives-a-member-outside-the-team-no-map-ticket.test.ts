// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('clientmapsearch', 'clientmapsearch');
  owner = await w.decider('Client map search owner');
}, 180_000);
afterAll(async () => await w?.drop());

const ticketHits = async (member: Parameters<WayfinderWorld['read']>[0]): Promise<string> =>
  JSON.stringify(await w.read(member, { read: 'task.search', query: 'Marigold' }));

it("search gives a member outside the team no ticket through a map's grant", async () => {
  const map = await w.create(owner, { title: 'Marigold map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Marigold ticket' }, { parentId: map.id });
  const staff = await w.member('Staff map reader', ['read'], { kind: 'record', id: map.id });
  const client = await w.member('Client map reader', ['read'], { kind: 'record', id: map.id });
  await w.db.admin.execute(
    `update public.memberships set role_key = 'client' where business_id = $1 and person_id = $2`,
    [w.business, client.personId],
  );
  // The ticket is real and found through the map's grant by a reader on the team.
  expect(await ticketHits(staff)).toContain(ticket.id);
  // `task.read` keeps a map's tickets off a client surface (WF-1); search agrees.
  expect(codeOf(await w.read(client, { read: 'task.read', recordId: ticket.id }))).not.toBe(
    'applied',
  );
  const found = await ticketHits(client);
  for (const marker of [ticket.id, 'Marigold ticket']) {
    expect(found, marker).not.toContain(marker);
  }
}, 30_000);
