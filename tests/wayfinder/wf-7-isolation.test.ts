// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one isolation case: three crossings on one world */
//
// `WF-7 isolation` (roadmap #640, standing gate 9): the research run's agent
// resolves and reads only the ticket its delegation is minted for. Three
// crossings, statuses checked, with canaries planted on the foreign side that
// never appear in any answer, refusals included, and the foreign ticket left
// as it was.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Decider } from '../commands/agent-fixture.ts';
import { codeOf, must, wayfinderWorld, type WayfinderWorld } from './world.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

const ticketsOf = (answer: unknown) =>
  (answer as { detail: { tickets: Record<string, string> } }).detail.tickets;

describe.skipIf(serverUrl === undefined)('WF-7 isolation', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let pat: Decider;

  beforeAll(async () => {
    w = await wayfinderWorld('wf7iso', 'wfseveniso');
    owner = await w.decider('owner');
    pat = await w.decider('pat');
  }, 180_000);

  afterAll(async () => await w?.drop());

  /** A task `by` approved and the agent picked up, typed research. */
  const researchPickup = async (by: Decider, title: string) => {
    const picked = await w.pickUp(by, title);
    const typed = await w.asPerson(by, {
      command: 'task.set_type',
      operationId: randomUUID(),
      recordId: picked.taskId,
      expectedRevision: await w.revisionOf(picked.taskId),
      taskType: 'research',
    });
    expect(codeOf(typed)).toBe('applied');
    return picked;
  };

  const resolveOf = async (ticket: string, business = w.business) => ({
    command: 'task.resolve',
    operationId: randomUUID(),
    recordId: ticket,
    expectedRevision: await w.revisionOf(ticket, business),
    answer: 'the answer',
    gist: 'the gist',
  });

  it('WF-7 isolation', async () => {
    // The foreign sides, each with a canary title.
    const bea = await w.outsider('bea');
    const bravo = await w.as(
      bea,
      {
        command: 'map.chart',
        title: 'canary-map-bravo',
        tickets: [{ ref: 'x', title: 'canary-ticket-bravo', type: 'research' }],
      },
      w.bravo,
    );
    must(bravo, 'chart bravo');
    const bravoTicket = ticketsOf(bravo)['x'] as string;
    await w.grant(owner, 'assign');
    const clientB = await w.as(owner, {
      command: 'map.chart',
      title: 'canary-map-client-B',
      tickets: [{ ref: 'b', title: 'canary-ticket-client-B', type: 'research' }],
    });
    const mapB = must(clientB, 'chart client B').id;
    must(
      await w.as(owner, {
        command: 'map.scope',
        recordId: mapB,
        expectedRevision: await w.revisionOf(mapB),
        client: randomUUID(),
      }),
      'scope B',
    );
    const clientTicket = ticketsOf(clientB)['b'] as string;
    const patPicked = await researchPickup(pat, 'canary-ticket-pat');
    const own = await researchPickup(owner, 'the run ticket');

    const foreign = [
      bravoTicket,
      clientTicket,
      mapB,
      patPicked.taskId,
      'canary-map-bravo',
      'canary-ticket-bravo',
      'canary-map-client-B',
      'canary-ticket-client-B',
      'canary-ticket-pat',
    ];
    const clean = (answer: unknown) => {
      const text = JSON.stringify(answer);
      for (const canary of foreign) expect(text).not.toContain(canary);
    };
    const unchanged = async (ticket: string, business = w.business) => {
      const rows = await w.db.admin.execute<{ readonly answer: string | null }>(
        `select data->>'answer' as answer from public.records where business_id = $1 and id = $2`,
        [business, ticket],
      );
      expect(rows.map((row) => row.answer)).toStrictEqual([null]);
    };

    // 1. Another business: the credential reaches nothing of bravo's ticket.
    const acrossBusiness = await w.asAgent(await resolveOf(bravoTicket, w.bravo), own.credential);
    expect(codeOf(acrossBusiness)).toBe('DELEGATION_OUT_OF_PURPOSE');
    clean(acrossBusiness);
    await unchanged(bravoTicket, w.bravo);

    // 2. Another client in the same business: a ticket on client B's map is
    // neither resolved nor read.
    const acrossClient = await w.asAgent(await resolveOf(clientTicket), own.credential);
    expect(codeOf(acrossClient)).toBe('DELEGATION_OUT_OF_PURPOSE');
    clean(acrossClient);
    const readClient = await w.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: clientTicket },
      own.credential,
    );
    expect(codeOf(readClient)).toBe('DELEGATION_OUT_OF_PURPOSE');
    clean(readClient);
    await unchanged(clientTicket);

    // 3. Another person under a live delegation: pat's picked-up ticket is not
    // reached with the owner's delegation, nor the owner's with pat's.
    const acrossPerson = await w.asAgent(await resolveOf(patPicked.taskId), own.credential);
    expect(codeOf(acrossPerson)).toBe('DELEGATION_OUT_OF_PURPOSE');
    clean(acrossPerson);
    await unchanged(patPicked.taskId);
    const backwards = await w.asAgent(await resolveOf(own.taskId), patPicked.credential);
    expect(codeOf(backwards)).toBe('DELEGATION_OUT_OF_PURPOSE');
    await unchanged(own.taskId);

    // The refusals are not vacuous: the run resolves its own ticket, and its
    // answer names nothing foreign.
    const resolved = await w.asAgent(await resolveOf(own.taskId), own.credential);
    expect(codeOf(resolved)).toBe('applied');
    clean(resolved);
  }, 240_000);
});
