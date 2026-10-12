// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useBrokerWorld('x1372exactreply');
usePeople();

it('the durable top-up answer reports the exact raised hold', async () => {
  await setThreshold(null);
  const { work, runId, askId } = await stopped('exact top-up answer');
  await s.db.admin.execute('update public.budget_caps set limit_minor = $2 where id = $1', [
    s.capId,
    (2n ** 62n).toString(),
  ]);
  const before = await moneyOf(runId);
  const operationId = randomUUID();
  const result = await executeCommand(s.db.app, s.business, people.approver.presented, 'api', {
    command: 'run.top_up',
    operationId,
    recordId: work.taskId,
    runId,
    askId,
    amountMinor: Number.MAX_SAFE_INTEGER,
    currency: 'AUD',
  });
  expect(result).toMatchObject({ command: 'run.top_up', detail: { state: 'applied' } });
  const after = await moneyOf(runId);
  expect(after.held).toBe((BigInt(before.held) + BigInt(Number.MAX_SAFE_INTEGER)).toString());
  const [operation] = await s.db.admin.execute<{ reported: string }>(
    `select result #>> '{detail,heldMinor}' as reported from public.operations
      where business_id = $1 and operation_id = $2`,
    [s.business, operationId],
  );
  expect(
    operation?.reported,
    'the durable response must agree with the reservation in minor units',
  ).toBe(after.held);
});
