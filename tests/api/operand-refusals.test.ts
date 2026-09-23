// SPDX-License-Identifier: AGPL-3.0-only
//
// Five declarations that answered an outage where a decision was owed.
//
// `tests/acceptance/surface-inventory.test.ts` posts a well-formed envelope
// with no operation fields to every declaration, and on 2241725 five of them
// answered a plain-text 500: `task.create`, `task.restore`, `task.purge`,
// `task.read` and `preset.plan`. The mounted app's client draws a non-2xx with
// no refusal body as *unavailable*, so a malformed request was shown as a
// broken server -- the distinction checklist B7 requires to be real.
//
// Each case here is the same question asked over the real boundary: an operand
// that is absent, or present with the wrong type, is refused by name with a
// fix line, in the pattern `task.decide` already uses (`FIELD_VALUE_INVALID`
// 422). The wrong-type spellings are here because a guard that only checked for
// `undefined` would move the fault one spelling along rather than remove it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { grantTo } from '../commands/fixture.ts';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';

let fixture: ApiFixture;
let api: Hono;
let token: string;

beforeAll(async () => {
  fixture = await createApiFixture('operand_refusals');
  // The purge takes `manage`, and a caller refused `SCOPE_NOT_GRANTED` never
  // reaches the operand the case is about.
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, fixture.member, 'manage');
  });
  api = fixture.compose();
  token = await tokenFor(fixture.member.presented.subject);
}, 60_000);

afterAll(async () => {
  await fixture.drop();
});

interface Case {
  readonly path: string;
  readonly operands: Readonly<Record<string, unknown>>;
  readonly named: string;
}

/** The operands each of the five needs, absent and then mistyped. */
const CASES: readonly Case[] = [
  { path: 'task/create', operands: {}, named: 'fields' },
  { path: 'task/create', operands: { fields: 'a title' }, named: 'fields' },
  { path: 'task/create', operands: { fields: ['title'] }, named: 'fields' },
  { path: 'task/create', operands: { fields: null }, named: 'fields' },
  { path: 'task/restore', operands: {}, named: 'batchId' },
  { path: 'task/restore', operands: { batchId: 7 }, named: 'batchId' },
  { path: 'task/purge', operands: {}, named: 'olderThanDays' },
  { path: 'task/purge', operands: { olderThanDays: '30' }, named: 'olderThanDays' },
  { path: 'task/purge', operands: { olderThanDays: -1 }, named: 'olderThanDays' },
  { path: 'task/purge', operands: { olderThanDays: 1.5 }, named: 'olderThanDays' },
  { path: 'task/read', operands: {}, named: 'recordId' },
  { path: 'task/read', operands: { recordId: 42 }, named: 'recordId' },
  { path: 'preset/plan', operands: {}, named: 'recordTypeKey' },
  {
    path: 'preset/plan',
    operands: { recordTypeKey: 'task', presetKey: 'p' },
    named: 'fields',
  },
  {
    path: 'preset/plan',
    operands: { recordTypeKey: 'task', presetKey: 7, fields: [] },
    named: 'presetKey',
  },
  {
    path: 'preset/plan',
    operands: { recordTypeKey: 'task', presetKey: 'p', fields: [null] },
    named: 'fields',
  },
];

describe('an operand the operation needs, absent or of the wrong type', () => {
  for (const one of CASES) {
    it(`${one.path} ${JSON.stringify(one.operands)} is refused by name`, async () => {
      const answer = await post(
        api,
        `/api/b/alpha/${one.path}`,
        { operationId: randomUUID(), ...one.operands },
        authorised(token),
      );
      // `raw` is how `post` reports a plain-text body, which is what a fault
      // answers; naming it first makes a regression read as the fault it is.
      expect(answer.body['raw']).toBeUndefined();
      expect(answer.status).toBe(422);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toContain(one.named);
      expect((answer.body['fixes'] as readonly string[]).length).toBeGreaterThan(0);
    });
  }

  it('still serves a well-formed request on each of the five', async () => {
    // The guard must refuse only what is malformed. One honest request apiece,
    // answered by the operation itself rather than by the new check.
    const created = await post(
      api,
      '/api/b/alpha/task/create',
      { operationId: randomUUID(), fields: { title: 'kept' } },
      authorised(token),
    );
    expect(created.status).toBe(200);

    const read = await post(
      api,
      '/api/b/alpha/task/read',
      { recordId: created.body['recordId'] },
      authorised(token),
    );
    expect(read.status).toBe(200);

    const restore = await post(
      api,
      '/api/b/alpha/task/restore',
      { operationId: randomUUID(), batchId: randomUUID() },
      authorised(token),
    );
    expect(restore.body['code']).toBe('NOT_FOUND');

    const purge = await post(
      api,
      '/api/b/alpha/task/purge',
      { operationId: randomUUID(), olderThanDays: 30 },
      authorised(token),
    );
    expect(purge.status).toBe(200);

    const plan = await post(
      api,
      '/api/b/alpha/preset/plan',
      { recordTypeKey: 'task', presetKey: 'p', fields: [] },
      authorised(token),
    );
    // `manage` on the family the request names, granted above, is what the
    // planner asks for, so an empty field list is an empty plan.
    expect(plan.status).toBe(200);
  });
});
