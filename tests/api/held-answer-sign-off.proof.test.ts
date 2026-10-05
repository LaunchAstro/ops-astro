// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { attempts, launched, r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('prv942signoff');

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

it('a held provider answer cannot bypass client sign-off enabled before its comment applies', async () => {
  const { taskId, credential } = await launched();
  let loseComment = true;
  let providerEffects = 0;
  const transport: Transport = async (path, body, bearer, delegation) => {
    // The provider has answered, but the in-app effect has not reached the API.
    if (path.endsWith('/task/comment') && loseComment) {
      loseComment = false;
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
    provider: {
      call: () => {
        providerEffects += 1;
        return Promise.resolve({ status: 200, body: '{}' });
      },
    },
  });
  expect(await worker.applyOnce(taskId)).toEqual({ fault: { status: 503 } });
  const countComments = async () => await appliedComments(taskId);
  expect(await countComments()).toEqual([{ n: '0' }]);
  await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  await clientSignOff('true');
  try {
    expect.soft(await worker.applyOnce(taskId)).toMatchObject({
      refused: { code: 'CLIENT_SIGNOFF_REQUIRED' },
    });
    expect.soft(await countComments()).toEqual([{ n: '0' }]);
    expect
      .soft(await attempts(taskId))
      .toMatchObject([{ state: 'dispatched', observed: false, held: 'held' }]);
    expect(providerEffects).toBe(1);
  } finally {
    await clientSignOff('false');
  }
});
