// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one shared world and its readers */
//
// A ticket's detail names the map it belongs to, as `map`, so the task page
// can link back to it: only to a member whose grants reach that map (a
// business-wide read, or a read on the map itself), never to a reader holding
// the ticket alone, and never to an agent credential. A map names no map, and
// a task on no map names none.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_ASSURANCE, type Session } from '../../packages/core-records/src/index.ts';
import { runRead } from '../../packages/core-commands/src/reads/dispatch.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type Made, type WayfinderWorld } from './world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('a ticket’s map on task.read', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let map: Made;
  let ticket: Made;
  let loose: Made;

  /** The task detail `member` is served, after proving the read was admitted. */
  async function detailFor(member: Member, recordId: string): Promise<Record<string, unknown>> {
    const answer = await w.read(member, { read: 'task.read', recordId });
    expect(codeOf(answer)).toBe('applied');
    return (answer as { readonly task: Record<string, unknown> }).task;
  }

  const onRecord = async (name: string, id: string): Promise<Member> => {
    const reader = await w.member(name, []);
    await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id });
    });
    return reader;
  };

  beforeAll(async () => {
    w = await wayfinderWorld('ticketmap', 'ticketmap');
    owner = await w.decider('owner');
    map = await w.create(owner, { title: 'the map' }, { taskType: 'map' });
    ticket = await w.create(owner, { title: 'a ticket' }, { parentId: map.id });
    loose = await w.create(owner, { title: 'on no map' });
  });

  afterAll(async () => {
    await w.drop();
  });

  it('names the map to a business-wide reader of its ticket', async () => {
    expect((await detailFor(owner, ticket.id))['map']).toEqual({
      id: map.id,
      key: expect.any(String) as string,
      title: 'the map',
    });
  });

  it('names the map to a reader holding the map, who reads the ticket through it', async () => {
    const reader = await onRecord('map-holder', map.id);
    expect((await detailFor(reader, ticket.id))['map']).toMatchObject({ id: map.id });
  });

  it('names no map to a reader holding the ticket alone', async () => {
    const reader = await onRecord('ticket-holder', ticket.id);
    const detail = await detailFor(reader, ticket.id);
    expect(detail['title']).toBe('a ticket');
    expect(detail['map']).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('the map');
  });

  it('names no map on a map itself, nor on a task on no map', async () => {
    expect((await detailFor(owner, map.id))['map']).toBeNull();
    expect((await detailFor(owner, loose.id))['map']).toBeNull();
  });

  it('sends an agent credential no map, though its person may read the map', async () => {
    const session: Session = {
      businessId: w.business,
      loginId: randomUUID(),
      personId: String(owner.personId),
      actorId: String(owner.actorId),
      roleKey: 'admin',
      assurance: NO_ASSURANCE,
      credentialScope: ['task:read'],
    } as Session;
    const answer = await w.db.app.withBusiness(
      w.business,
      async (tx) => await runRead(tx, session, { read: 'task.read', recordId: ticket.id } as never),
    );
    expect(codeOf(answer)).toBe('applied');
    const task = (answer as unknown as { readonly task: Record<string, unknown> }).task;
    expect(task['title']).toBe('a ticket');
    expect('map' in task).toBe(false);
  });
});
