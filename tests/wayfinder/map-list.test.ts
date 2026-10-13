// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one shared world and its readers */
//
// `map.list`: the live maps of the business that the caller's grants reach,
// as `map.view`'s door would admit them. A business-wide reader sees every
// map; a record grant reaches only its own map, never a ticket's map or a map
// filed under it. A grantless member is refused, not handed an empty list, and
// a map never reaches a client login (WF-1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type WayfinderWorld,
} from './world.ts';

interface Listed {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('map.list', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let plain: Made;
  let ticketed: Made;
  let ticket: Made;
  let other: Made;
  let nested: Made;

  const list = async (member: Member, business = w.business) =>
    await w.read(member, { read: 'map.list' }, business);

  /** The titles listed, after proving the read was admitted. */
  async function titlesFor(member: Member): Promise<readonly (string | null)[]> {
    const answer = await list(member);
    expect(codeOf(answer)).toBe('applied');
    return (answer as { readonly maps: readonly Listed[] }).maps.map((map) => map.title);
  }

  const onRecord = async (name: string, ...recordIds: string[]): Promise<Member> => {
    const reader = await w.member(name, []);
    for (const id of recordIds) {
      // eslint-disable-next-line no-await-in-loop -- grants issued one after another
      await w.db.app.withBusiness(w.business, async (tx) => {
        await grantTo(tx, reader, 'read', { kind: 'record', id });
      });
    }
    return reader;
  };

  beforeAll(async () => {
    w = await wayfinderWorld('maplist', 'maplist');
    owner = await w.decider('owner');
    plain = await w.create(owner, { title: 'B plain map' }, { taskType: 'map' });
    ticketed = await w.create(owner, { title: 'A ticketed map' }, { taskType: 'map' });
    ticket = await w.create(owner, { title: 'a ticket' }, { parentId: ticketed.id });
    other = await w.create(owner, { title: 'C other map' }, { taskType: 'map' });
    nested = await w.create(
      owner,
      { title: 'D nested map' },
      { taskType: 'map', parentId: other.id },
    );
    await w.create(owner, { title: 'a plain task' });
  });

  afterAll(async () => {
    await w.drop();
  });

  it('lists every live map, by title, to a business-wide reader, and no plain task', async () => {
    expect(await titlesFor(owner)).toEqual([
      'A ticketed map',
      'B plain map',
      'C other map',
      'D nested map',
    ]);
    const answer = (await list(owner)) as { readonly maps: readonly Listed[] };
    expect(answer.maps[0]).toEqual({
      id: ticketed.id,
      key: expect.any(String) as string,
      title: 'A ticketed map',
    });
  });

  it('reaches a map by its own grant, never up from a ticket', async () => {
    const reader = await onRecord('ticket-and-plain', ticket.id, plain.id);
    expect(await titlesFor(reader)).toEqual(['B plain map']);
  });

  it('reaches a nested map only by its own grant, never down from the outer map', async () => {
    const outer = await onRecord('outer-only', other.id);
    expect(await titlesFor(outer)).toEqual(['C other map']);
    const inner = await onRecord('nested-only', nested.id);
    expect(await titlesFor(inner)).toEqual(['D nested map']);
  });

  it('refuses a member holding no grant, rather than answering an empty list', async () => {
    const none = await w.member('no-grant', []);
    expect(codeOf(await list(none))).toBe('SCOPE_NOT_GRANTED');
  });

  it('refuses a client login not-found, whatever its grant reaches', async () => {
    const client = await w.member('client-login', ['read']);
    await w.db.admin.execute(
      'update public.memberships set role_key = $3 where business_id = $1 and person_id = $2',
      [w.business, client.personId, 'client'],
    );
    expect(codeOf(await list(client))).toBe('NOT_FOUND');
  });

  it('leaves out a trashed map, a map retyped to a task and another business’s map', async () => {
    const trashed = await w.create(owner, { title: 'E trashed map' }, { taskType: 'map' });
    const retyped = await w.create(owner, { title: 'F retyped map' }, { taskType: 'map' });
    expect(await titlesFor(owner)).toEqual(
      expect.arrayContaining(['E trashed map', 'F retyped map']),
    );
    must(
      await w.as(owner, {
        command: 'task.trash',
        recordId: trashed.id,
        expectedRevision: await w.revisionOf(trashed.id),
      }),
      'trash',
    );
    must(
      await w.as(owner, {
        command: 'task.set_type',
        recordId: retyped.id,
        expectedRevision: await w.revisionOf(retyped.id),
        taskType: 'task',
      }),
      'retype',
    );
    const outsider = await w.outsider('bravo-reader');
    await w.create(outsider, { title: 'G bravo map' }, { taskType: 'map' }, w.bravo);
    const titles = await titlesFor(owner);
    expect(titles).not.toContain('E trashed map');
    expect(titles).not.toContain('F retyped map');
    expect(titles).not.toContain('G bravo map');
    expect(titles).toContain('B plain map');
  });

  it('writes one audit event per call, applied or refused', async () => {
    const before = (await w.audit()).filter((line) => line.command === 'map.list').length;
    await list(owner);
    await list(await w.member('audited-no-grant', []));
    const after = (await w.audit()).filter((line) => line.command === 'map.list');
    expect(after.slice(before).map((line) => [line.outcome, line.code])).toEqual([
      ['applied', null],
      ['refused', 'SCOPE_NOT_GRANTED'],
    ]);
  });
});
