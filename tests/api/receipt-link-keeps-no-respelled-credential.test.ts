// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: a provider answer that re-spells the observing agent's own
// delegation credential (standard base64, split by a separator) is recorded
// absent, stored nowhere and shown on no receipt. Through the real worker,
// observe and task.receipt; the credential is the one the pickup minted.
import { expect, it as vitestIt } from 'vitest';
import {
  asPerson,
  attempts,
  HOST,
  launched,
  linking,
  noDatabase,
  useReceiptWorld,
  workerOn,
} from './aw-08-receipt-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useReceiptWorld('rcptrespelled');

it("a provider receipt re-spelling the agent's own credential is stored and shown as no link", async () => {
  const { taskId, credential } = await launched();
  const standard = Buffer.from(credential, 'base64url').toString('base64');
  const link = `https://${HOST}/effects/${standard.slice(0, 22)}.${standard.slice(22)}`;
  const outcome = await workerOn(credential, linking(link)).applyOnce(taskId);
  if (!('applied' in outcome)) throw new Error('the synthetic effect did not apply');
  const answer = await asPerson('task.receipt', { attemptId: outcome.applied.attemptId });
  expect(answer.status).toBe(200);
  expect(answer.body['receipt']).toMatchObject({ link: null, settlement: { state: 'settled' } });
  expect(await attempts(taskId)).toMatchObject([{ observed: true, link: null }]);
});
