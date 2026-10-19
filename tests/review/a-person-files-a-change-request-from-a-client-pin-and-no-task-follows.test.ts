// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one pin's filing and its refusals, top to bottom */
//
// C57 (#2016): a person holding `proposal:write` files one change request from a client
// pin, with their own bounded text. It is proposed, held at the review's client, and makes
// no task: not when filed, not when approved (a worker makes it, #2117). An internal pin,
// a fabricated or malformed id, unbounded text and a second filing of the pin write nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 filing: DATABASE_URL is unset.');

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57file');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C57 filing a change request', () => {
  it('C57 a person files a change request from a client pin', async () => {
    const { clientPin } = await w.pins();
    const filed = await w.propose(w.ava, clientPin);
    expect(codeOf(filed)).toBe('not-a-refusal');
    const id = detailOf(filed)['changeRequestId'];
    expect(detailOf(filed)['state']).toBe('proposed');

    const row = (await w.requests(w.world.business)).find((r) => r.id === id);
    expect(row).toStrictEqual({
      id,
      comment_id: clientPin,
      task_id: w.taskA,
      party_id: w.partyA,
      request_text: 'Move the heading above the photo on the phone layout',
      state: 'proposed',
      proposed_by_person_id: w.ava.personId,
      decided_by_person_id: null,
      created_task_id: null,
    });
  });

  it('C57 never auto-applied', async () => {
    const { clientPin } = await w.pins();
    const tasks = await w.tasks(w.world.business);
    const id = detailOf(await w.propose(w.ava, clientPin))['changeRequestId'];
    expect(await w.tasks(w.world.business)).toBe(tasks);
    expect(codeOf(await w.decide(w.ava, id, 'approve'))).toBe('not-a-refusal');
    // Approval is a decision only: the task is a worker's to make, under its lease.
    expect(await w.tasks(w.world.business)).toBe(tasks);
    const row = (await w.requests(w.world.business)).find((r) => r.id === id);
    expect(row?.state).toBe('approved');
    expect(row?.created_task_id).toBeNull();
  });

  it('C57 only a client pin, once, with bounded text', async () => {
    const { clientPin, internalPin } = await w.pins();
    const before = (await w.requests(w.world.business)).length;

    // An internal pin answers as a comment that is not there.
    expect(codeOf(await w.propose(w.ava, internalPin))).toBe('NOT_FOUND');
    expect(codeOf(await w.propose(w.ava, randomUUID()))).toBe('NOT_FOUND');
    expect(codeOf(await w.propose(w.ava, 'not-an-id'))).toBe('NOT_FOUND');
    // A task that is no pin: the review's own task.
    expect(codeOf(await w.propose(w.ava, w.taskA))).toBe('NOT_FOUND');
    const unbounded = await Promise.all(
      ['', 'x'.repeat(2001), 42, null].map(
        async (text) => await w.propose(w.ava, clientPin, { text }),
      ),
    );
    expect(unbounded.map((answer) => codeOf(answer))).toStrictEqual([
      'FIELD_VALUE_INVALID',
      'FIELD_VALUE_INVALID',
      'FIELD_VALUE_INVALID',
      'FIELD_VALUE_INVALID',
    ]);
    expect((await w.requests(w.world.business)).length).toBe(before);

    expect(codeOf(await w.propose(w.ava, clientPin))).toBe('not-a-refusal');
    expect(codeOf(await w.propose(w.ben, clientPin))).toBe('CHANGE_REQUEST_ALREADY_FILED');
    expect((await w.requests(w.world.business)).length).toBe(before + 1);
  });
});
