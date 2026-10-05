// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE, type Provider } from '../../apps/worker/usage.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { attempts, HOST, launched, r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('solow074retry');

/** The agent call as the API answers it, before a test loses or keeps that answer. */
const throughApi: Transport = async (path, body, bearer, delegation) =>
  await r.api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
    },
    body,
  });

/** The worker under the launched delegation, with `call` as its provider. */
function workerWith(transport: Transport, delegation: string, call: Provider['call']) {
  return createWorker({
    transport,
    businessKey: 'alpha',
    credential: r.agentToken,
    delegation,
    reporter: SYNTHETIC_USAGE,
    provider: { call },
  });
}

it('losing both comment answers does not repeat a successful provider effect', async () => {
  const { taskId, credential } = await launched();
  let lost = 0;
  let providerEffects = 0;
  const transport: Transport = async (path, body, bearer, delegation) => {
    const answer = await throughApi(path, body, bearer, delegation);
    if (path.endsWith('/task/comment') && lost < 2) {
      expect(answer.status).toBe(200);
      lost += 1;
      throw new Error('Sol injected lost comment answer');
    }
    return answer;
  };
  const worker = workerWith(transport, credential, () => {
    providerEffects += 1;
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({ link: `https://${HOST}/effect-${providerEffects}` }),
    });
  });
  await expect(worker.applyOnce(taskId)).rejects.toThrow('Sol injected lost comment answer');
  expect(lost).toBe(2);
  expect(providerEffects).toBe(1);
  const comments = await r.fixture.db.admin.execute<{ count: string }>(
    `select count(*)::text as count from public.operations
      where business_id = $1 and record_id = $2 and command = 'task.comment' and outcome = 'applied'`,
    [r.fixture.business, taskId],
  );
  expect(comments).toEqual([{ count: '1' }]);
  expect(await attempts(taskId)).toMatchObject([
    { state: 'dispatched', observed: false, held: 'held' },
  ]);
  expect(await worker.applyOnce(taskId)).toHaveProperty('applied');
  expect
    .soft(
      providerEffects,
      'one launched attempt must call its provider once across transport retries',
    )
    .toBe(1);
  expect(await attempts(taskId)).toMatchObject([
    { state: 'settled', observed: true, link: `https://${HOST}/effect-1` },
  ]);
});

it('concurrent resumptions of a held attempt do not duplicate its provider effect', async () => {
  const { taskId, credential } = await launched();
  let loseDispatch = true;
  let providerEffects = 0;
  const transport: Transport = async (path, body, bearer, delegation) => {
    const answer = await throughApi(path, body, bearer, delegation);
    if (path.endsWith('/task/dispatch') && loseDispatch) {
      expect(answer.status).toBe(200);
      loseDispatch = false;
      return new Response('{}', { status: 503 });
    }
    return answer;
  };
  const worker = workerWith(transport, credential, () => {
    providerEffects += 1;
    return Promise.resolve({ status: 200, body: '{}' });
  });
  expect(await worker.applyOnce(taskId)).toEqual({ fault: { status: 503 } });
  expect(providerEffects).toBe(0);
  const results = await Promise.all([worker.applyOnce(taskId), worker.applyOnce(taskId)]);
  expect(results.some((result) => 'applied' in result)).toBe(true);
  expect(await attempts(taskId)).toMatchObject([{ state: 'settled', observed: true }]);
  expect(providerEffects, 'the same held attempt was resumed twice').toBe(1);
});
