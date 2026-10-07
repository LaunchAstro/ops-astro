// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one world of two clients' maps, shared by the three surfaces */
// #714 and #715 (Sol round 3 of #355, R/sol/P14-FIX2.md) across a real crossing: map A is client A's,
// map B is client B's, and every ticket carries its map's client. A grant on one map reaches that
// map's tickets on the unattended list, task.rank and the live board, and never the other map's;
// a reader shown the client view is returned no map ticket of their own client.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardReach } from '../../packages/core-commands/src/reads/live-join.ts';
import { readUnattended } from '../../packages/core-records/src/inbox/unattended.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const onRecord = (id: string) => ({ kind: 'record' as const, id });

describe.skipIf(serverUrl === undefined)('WF-1 map reach across two clients', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  const clientA = randomUUID();
  const clientB = randomUUID();
  let mapA: string;
  let mapB: string;
  let ticketA: string;
  let ticketA2: string;
  let ticketB: string;
  let ticketB2: string;
  let plainA: string;

  const ticket = async (title: string, map: string) =>
    (await w.create(owner, { title }, { parentId: map })).id;
  const scope = async (map: string, client: string) => {
    must(
      await w.as(owner, {
        command: 'map.scope',
        recordId: map,
        expectedRevision: await w.revisionOf(map),
        client,
      }),
      'scope',
    );
  };
  const assign = async (recordId: string, who: Member) => {
    must(
      await w.as(owner, {
        command: 'task.assign',
        recordId,
        expectedRevision: await w.revisionOf(recordId),
        fields: { assignee: who.personId },
      }),
      'assign',
    );
  };
  const signOut = async (who: Member) => {
    await w.db.app.withBusiness(w.business, async (tx) => {
      await tx.query(
        'update person_logins set active = false, deactivated_at = now() where business_id = $1 and person_id = $2',
        [w.business, who.personId],
      );
    });
  };
  const operations = async (who: Member) => {
    await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, who, 'read', { kind: 'business', id: null }, false, 'operations');
    });
  };
  const retitle = async (recordId: string, title: string) => {
    must(
      await w.as(owner, {
        command: 'task.update',
        recordId,
        expectedRevision: await w.revisionOf(recordId),
        fields: { title },
      }),
      'retitle',
    );
  };
  const unattendedForOwner = async () =>
    (
      await w.db.app.withBusiness(
        w.business,
        async (tx) => await readUnattended(tx, owner.personId),
      )
    ).map((item) => item.subjectRecordId);

  beforeAll(async () => {
    w = await wayfinderWorld('wfm2', 'wfm2');
    owner = await w.decider('owner');
    await w.grant(owner, 'assign');
    await w.grant(owner, 'share');
    await addClient(w.db.app, w.business, clientA, owner);
    await addClient(w.db.app, w.business, clientB, owner);
    mapA = (await w.create(owner, { title: 'client A map' }, { taskType: 'map' })).id;
    mapB = (await w.create(owner, { title: 'client B map' }, { taskType: 'map' })).id;
    await scope(mapA, clientA);
    await scope(mapB, clientB);
    ticketA = await ticket('CLIENT-A-TICKET', mapA);
    ticketA2 = await ticket('CLIENT-A-TICKET-2', mapA);
    ticketB = await ticket('CLIENT-B-TICKET', mapB);
    ticketB2 = await ticket('CLIENT-B-TICKET-2', mapB);
    plainA = (await w.create(owner, { title: 'client A plain task' })).id;
    must(
      await w.as(owner, {
        command: 'task.set_party',
        recordId: plainA,
        expectedRevision: await w.revisionOf(plainA),
        fields: { client: clientA },
      }),
      'plain task for client A',
    );
    // The crossing is real: every ticket carries its own map's client, none is null.
    const links = await w.db.admin.execute<{ id: string; client: string | null }>(
      'select id, uuid_7::text as client from records where business_id = $1 and id = any($2::uuid[])',
      [w.business, [ticketA, ticketA2, ticketB, ticketB2, plainA]],
    );
    expect(Object.fromEntries(links.map((row) => [row.id, row.client]))).toStrictEqual({
      [ticketA]: clientA,
      [ticketA2]: clientA,
      [ticketB]: clientB,
      [ticketB2]: clientB,
      [plainA]: clientA,
    });
  }, 120_000);
  afterAll(async () => {
    await w?.drop();
  });

  it('unattended: a map grant reaches its own map’s tickets for recipient and operator, never the other client’s', async () => {
    const recipientA = await w.member('recipient-map-a', ['read'], onRecord(mapA));
    const recipientB = await w.member('recipient-map-b', ['read'], onRecord(mapB));
    const recipientPlain = await w.member('recipient-plain', ['read'], {
      kind: 'party',
      id: clientA,
    });
    const readerB = await w.member('reachable-map-b', ['read'], onRecord(mapB));
    const crossReader = await w.member('map-b-only-on-a-ticket', ['read'], onRecord(mapB));
    await assign(ticketA, recipientA);
    await assign(ticketB, recipientB);
    await assign(plainA, recipientPlain);
    await assign(ticketB2, readerB);
    await assign(ticketA2, crossReader);
    await Promise.all(
      [recipientA, recipientB, recipientPlain].map(async (who) => await signOut(who)),
    );

    // Recipient reach: a signed-in map B reader reaches map B's ticket and no ticket of map A.
    const listed = await unattendedForOwner();
    expect(listed).toEqual(expect.arrayContaining([ticketA, ticketB, plainA]));
    expect(listed, 'map B reader reaches map B ticket').not.toContain(ticketB2);
    expect(listed, 'map B grant reaches no map A ticket').toContain(ticketA2);

    // Operator visibility: map A's operator sees map A's items and nothing of client B.
    const operatorA = await w.member('operator-map-a', ['read'], onRecord(mapA));
    await operations(operatorA);
    const seenByA = await w.read(operatorA, { read: 'inbox.unattended' });
    expect(codeOf(seenByA)).toBe('applied');
    const textA = JSON.stringify(seenByA);
    expect(textA, 'map A operator, own map').toContain(ticketA);
    expect(textA, 'client to client').not.toContain(ticketB);
    expect(textA, 'client to client').not.toContain(recipientB.personId);

    // #714: a client-view operator linked to client A is shown client A's task and no map ticket of it.
    const viewer = await w.member('client-a-viewer', ['read'], { kind: 'party', id: clientA });
    await operations(viewer);
    await w.db.app.withBusiness(w.business, async (tx) => {
      await tx.query(
        "update memberships set role_key = 'client' where business_id = $1 and person_id = $2",
        [w.business, viewer.personId],
      );
    });
    expect(codeOf(await w.read(viewer, { read: 'task.read', recordId: ticketA }))).not.toBe(
      'applied',
    );
    const seenByViewer = await w.read(viewer, { read: 'inbox.unattended' });
    expect(codeOf(seenByViewer)).toBe('applied');
    const textViewer = JSON.stringify(seenByViewer);
    expect(textViewer, 'own client, ordinary task').toContain(plainA);
    expect(textViewer, 'own client, internal map ticket').not.toContain(ticketA);
    expect(textViewer, 'own client, internal map ticket').not.toContain(recipientA.personId);
    expect(textViewer, 'client to client').not.toContain(ticketB);
  });

  it('task.rank: a map A grant ranks beside a map A ticket, never beside a map B ticket', async () => {
    const writer = await w.member('ranker-map-a', ['read', 'write'], onRecord(mapA));
    // A grant on map B's second ticket alone: the target is written, its neighbour is not reached.
    await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, writer, 'write', onRecord(ticketB2));
    });
    const own = await w.as(writer, {
      command: 'task.rank',
      recordId: ticketA2,
      expectedRevision: await w.revisionOf(ticketA2),
      afterId: ticketA,
    });
    expect(codeOf(own), 'beside a ticket of the granted map').toBe('applied');
    const before = await w.revisionOf(ticketB2);
    const crossed = await w.as(writer, {
      command: 'task.rank',
      recordId: ticketB2,
      expectedRevision: before,
      afterId: ticketB,
    });
    expect(codeOf(crossed), 'beside a ticket of client B’s map').toBe('SCOPE_NOT_GRANTED');
    expect(await w.revisionOf(ticketB2)).toBe(before);
  });

  it('live board: a map reader’s digest moves with its own map’s ticket and never with the other client’s', async () => {
    const readerA = await w.member('live-map-a', ['read'], onRecord(mapA));
    const readerB = await w.member('live-map-b', ['read'], onRecord(mapB));
    const digest = async (who: Member) =>
      await boardReach(w.db.app, w.business, who.presented, who.personId);
    const a0 = await digest(readerA);
    const b0 = await digest(readerB);
    expect(a0).toBeDefined();
    expect(b0).toBeDefined();
    await retitle(ticketB, 'CLIENT-B-TICKET retitled');
    const a1 = await digest(readerA);
    const b1 = await digest(readerB);
    expect(b1, 'map B reader, own ticket').not.toBe(b0);
    expect(a1, 'client to client').toBe(a0);
    await retitle(ticketA, 'CLIENT-A-TICKET retitled');
    expect(await digest(readerA), 'map A reader, own ticket').not.toBe(a1);
    expect(await digest(readerB), 'client to client').toBe(b1);
  });
});
