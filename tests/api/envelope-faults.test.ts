// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope's own guard, over the real boundary, for the field an ordinary
// HTTP caller omits most easily.
//
// `commands/envelope.ts` guards the identity with
// `OPERATION_ID.test(request.operationId)`, and `RegExp.prototype.test`
// coerces its argument to a string. An omitted field arrives as `undefined`,
// coerces to the nine-character `"undefined"`, and passes the pattern; the
// real `undefined` then reaches `lookupAttempt`'s bound parameter and the
// driver raises `UNDEFINED_VALUE`, so the caller is answered a plain-text 500.
// `null` and `''` are refused correctly -- it is the absent field that gets
// through (L5-PROOFS handback, "Defects found in other lanes' files" 1).
//
// The register (`commands/register.ts`) promises `OPERATION_ID_REQUIRED` 422
// for exactly this, so the case asks for the status the table already says.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';

let fixture: ApiFixture;
let api: Hono;
let token: string;

beforeAll(async () => {
  fixture = await createApiFixture('envelope_faults');
  api = fixture.compose();
  token = await tokenFor(fixture.member.presented.subject);
}, 60_000);

afterAll(async () => {
  await fixture.drop();
});

describe('an envelope with no operation identity', () => {
  it('refuses the omitted field with OPERATION_ID_REQUIRED, not a fault', async () => {
    const answer = await post(api, '/api/b/alpha/task/create', {}, authorised(token));

    expect(answer.status).toBe(422);
    expect(answer.body['refused']).toBe(true);
    expect(answer.body['code']).toBe('OPERATION_ID_REQUIRED');
    // A fault answers in plain text, which `post` reports as `raw`. Naming it
    // here is what tells a 500 apart from the refusal this case is about.
    expect(answer.body['raw']).toBeUndefined();
  });

  it('refuses null and the empty string the same way, as it already did', async () => {
    for (const operationId of [null, ''] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await post(
        api,
        '/api/b/alpha/task/create',
        { operationId },
        authorised(token),
      );
      expect(answer.status, JSON.stringify(operationId)).toBe(422);
      expect(answer.body['code'], JSON.stringify(operationId)).toBe('OPERATION_ID_REQUIRED');
    }
  });

  it('still refuses a well-formed identity of the wrong shape', async () => {
    const answer = await post(
      api,
      '/api/b/alpha/task/create',
      { operationId: 'too short' },
      authorised(token),
    );
    expect(answer.status).toBe(422);
    expect(answer.body['code']).toBe('OPERATION_ID_REQUIRED');
  });
});

// The second half: a value the database's own check constraint refuses.
//
// `task.propose` reached the write with a `purpose` failing
// `proposal_versions_purpose_shape` and with a `step` that is not
// `{ kind, payload }`, and the constraint violation arrived at the caller as
// `SERVICE_UNAVAILABLE` 503 -- a malformed request shown as a broken server
// (WEB-PROPOSALS handback, "8e95e7d" and "Interface gaps for L3" 4). The
// register has `FIELD_VALUE_INVALID` 422 for exactly this and `API.md`
// already lists it on the `task.propose` row, so the answer is owed at the
// handler, before the write.

async function createTask(title: string): Promise<{ id: string; revision: number }> {
  const answer = await post(
    api,
    '/api/b/alpha/task/create',
    { operationId: randomUUID(), fields: { title } },
    authorised(token),
  );
  if (answer.status !== 200) {
    throw new Error(`task.create answered ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return { id: String(answer.body['recordId']), revision: Number(answer.body['revision']) };
}

async function proposeWith(
  task: { id: string; revision: number },
  overrides: Readonly<Record<string, unknown>>,
) {
  return await post(
    api,
    '/api/b/alpha/task/propose',
    {
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      purpose: 'draft_the_reply',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
      ...overrides,
    },
    authorised(token),
  );
}

describe('a propose whose value the column would refuse', () => {
  it('refuses a purpose outside the column shape with FIELD_VALUE_INVALID, not a 503', async () => {
    const task = await createTask('a purpose the column refuses');
    for (const purpose of ['Draft The Reply', 'draft-the-reply', '9_starts_with_a_digit', '']) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await proposeWith(task, { purpose });
      expect(answer.status, purpose).toBe(422);
      expect(answer.body['code'], purpose).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names'], purpose).toStrictEqual(['purpose']);
    }
  });

  it('refuses a step that is not { kind, payload } the same way', async () => {
    const task = await createTask('a step the column refuses');
    for (const step of ['compose', { payload: {} }, { kind: '', payload: {} }, { kind: 'c' }]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await proposeWith(task, { step });
      expect(answer.status, JSON.stringify(step)).toBe(422);
      expect(answer.body['code'], JSON.stringify(step)).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names'], JSON.stringify(step)).toStrictEqual(['step']);
    }
  });

  it('still applies a purpose and a step the columns accept', async () => {
    const task = await createTask('the positive control');
    const answer = await proposeWith(task, {});
    expect(answer.status).toBe(200);
    expect(String(answer.body['recordId'])).toBe(task.id);
  });
});
