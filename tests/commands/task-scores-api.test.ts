// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9 marks command on the API and command line: cases kept beside task-
// scores.test.ts, each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { authorised, BUSINESS_KEY, post } from '../api/fixture.ts';
import { api, credential, serverUrl, setUp, tearDown } from './scores-api-world.ts';

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** The command line's transport, straight into the application. */
const transport: Transport = async (path, body, bearer) =>
  await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body,
    }),
  );

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command on the API and command line', () => {
  it('sets the marks through the route and through the generated command line', async () => {
    const created = await post(
      api,
      `/api/b/${BUSINESS_KEY}/task/create`,
      { operationId: randomUUID(), fields: { title: 'marked on every surface' } },
      authorised(credential),
    );
    expect(created.status).toBe(200);
    const recordId = String(created.body['recordId']);

    const route = await post(
      api,
      `/api/b/${BUSINESS_KEY}/task/set_scores`,
      {
        operationId: randomUUID(),
        recordId,
        expectedRevision: Number(created.body['revision']),
        fields: { impact: 7, confidence: 9 },
      },
      authorised(credential),
    );
    expect(route.status, JSON.stringify(route.body)).toBe(200);

    const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential });
    const line = await cli.run('task.set_scores', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(route.body['revision']),
      fields: { ease: 11 },
    });
    const refusal = line.body as Readonly<Record<string, unknown>>;
    expect([line.status, refusal['code'], refusal['names']]).toStrictEqual([
      422,
      'FIELD_VALUE_INVALID',
      ['ease'],
    ]);

    const applied = await cli.run('task.set_scores', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(route.body['revision']),
      fields: { ease: 8 },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  });
});
