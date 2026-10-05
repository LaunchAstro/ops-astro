// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { attempts, HOST, launched, linking, r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('prv942r21');

/** The agent call as the API answers it. */
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

/** The task's applied comments, counted as the administrator. */
const appliedComments = async (taskId: string) =>
  await r.fixture.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.operations
      where business_id = $1 and record_id = $2 and command = 'task.comment' and outcome = 'applied'`,
    [r.fixture.business, taskId],
  );

/** The business's client sign-off setting, set as the administrator. */
const clientSignOff = async (value: 'true' | 'false') =>
  await r.fixture.db.admin.execute(
    `update public.business_settings set value = '${value}'::jsonb
      where business_id = $1 and key = 'client_sign_off_required'`,
    [r.fixture.business],
  );

it('an applied comment is still observed and settled after client sign-off turns on', async () => {
  const { taskId, credential } = await launched();
  await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  await clientSignOff('false');
  const link = `https://${HOST}/effects/${randomUUID()}`;
  const linked = linking(link);
  let providerCalls = 0;
  let loseObserve = true;
  const commentStatuses: number[] = [];
  const transport: Transport = async (path, body, bearer, delegation) => {
    // The comment applied; observe's request never reaches the API.
    if (path.endsWith('/task/observe') && loseObserve) {
      loseObserve = false;
      return new Response('{}', { status: 503 });
    }
    const answer = await throughApi(path, body, bearer, delegation);
    if (path.endsWith('/task/comment')) commentStatuses.push(answer.status);
    return answer;
  };
  const worker = createWorker({
    transport,
    businessKey: 'alpha',
    credential: r.agentToken,
    delegation: credential,
    reporter: SYNTHETIC_USAGE,
    provider: {
      call: async (...args) => {
        providerCalls += 1;
        return await linked.call(...args);
      },
    },
  });

  expect(await worker.applyOnce(taskId)).toEqual({ fault: { status: 503 } });
  expect(commentStatuses).toEqual([200]);
  expect(await appliedComments(taskId)).toEqual([{ n: '1' }]);
  expect(providerCalls).toBe(1);
  expect(await attempts(taskId)).toMatchObject([
    { state: 'dispatched', observed: false, held: 'held' },
  ]);

  await clientSignOff('true');
  try {
    await worker.applyOnce(taskId);
  } finally {
    await clientSignOff('false');
  }
  await worker.applyOnce(taskId);

  expect.soft(providerCalls).toBe(1);
  expect.soft(await appliedComments(taskId)).toEqual([{ n: '1' }]);
  const [attempt] = await attempts(taskId);
  expect(attempt).toMatchObject({ state: 'settled', observed: true, link });
  expect(attempt?.['held']).not.toBe('held');
});

it('a provider answer whose comment answer was lost is kept through a sign-off refusal and settles once', async () => {
  const { taskId, credential } = await launched();
  await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  await clientSignOff('false');
  const link = `https://${HOST}/effects/${randomUUID()}`;
  const linked = linking(link);
  let providerCalls = 0;
  let loseComment = true;
  const transport: Transport = async (path, body, bearer, delegation) => {
    const answer = await throughApi(path, body, bearer, delegation);
    // The comment applied; its answer never reaches the worker.
    if (path.endsWith('/task/comment') && loseComment) {
      loseComment = false;
      return new Response('{}', { status: 503 });
    }
    return answer;
  };
  const worker = createWorker({
    transport,
    businessKey: 'alpha',
    credential: r.agentToken,
    delegation: credential,
    reporter: SYNTHETIC_USAGE,
    provider: {
      call: async (...args) => {
        providerCalls += 1;
        return await linked.call(...args);
      },
    },
  });

  expect(await worker.applyOnce(taskId)).toEqual({ fault: { status: 503 } });
  expect(await appliedComments(taskId)).toEqual([{ n: '1' }]);

  await clientSignOff('true');
  try {
    expect(await worker.applyOnce(taskId)).toMatchObject({
      refused: { code: 'CLIENT_SIGNOFF_REQUIRED' },
    });
  } finally {
    await clientSignOff('false');
  }
  expect(await worker.applyOnce(taskId)).toMatchObject({ applied: { taskId } });

  expect(providerCalls).toBe(1);
  expect(await appliedComments(taskId)).toEqual([{ n: '1' }]);
  const [attempt] = await attempts(taskId);
  expect(attempt).toMatchObject({ state: 'settled', observed: true, link });
});

it('an applied comment is observed and settled while client sign-off stays on', async () => {
  const { taskId, credential } = await launched();
  await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  await clientSignOff('false');
  const link = `https://${HOST}/effects/${randomUUID()}`;
  const linked = linking(link);
  let loseObserve = true;
  const transport: Transport = async (path, body, bearer, delegation) => {
    // The comment applied; observe's request never reaches the API.
    if (path.endsWith('/task/observe') && loseObserve) {
      loseObserve = false;
      return new Response('{}', { status: 503 });
    }
    return await throughApi(path, body, bearer, delegation);
  };
  const worker = createWorker({
    transport,
    businessKey: 'alpha',
    credential: r.agentToken,
    delegation: credential,
    reporter: SYNTHETIC_USAGE,
    provider: linked,
  });

  expect(await worker.applyOnce(taskId)).toEqual({ fault: { status: 503 } });
  await clientSignOff('true');
  try {
    expect(await worker.applyOnce(taskId)).toMatchObject({ applied: { taskId } });
    expect(await appliedComments(taskId)).toEqual([{ n: '1' }]);
    const [attempt] = await attempts(taskId);
    expect(attempt).toMatchObject({ state: 'settled', observed: true, link });
  } finally {
    await clientSignOff('false');
  }
});
