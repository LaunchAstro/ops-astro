// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useBrokerWorld('x1372null');
usePeople();

it.each([
  { field: 'amount', amount: null, currency: 'AUD' },
  { field: 'currency', amount: 300, currency: null },
])(
  'a database top-up with null $field cannot reopen the budget wait',
  async ({ amount, currency }) => {
    await setThreshold(null);
    const { runId, askId } = await stopped('null budget answer');
    const result = await s.db.app
      .withBusiness(s.business, async (tx) => {
        await tx.query(
          `insert into public.budget_answers
         (business_id, id, ask_id, run_id, kind, amount_minor, currency, first_person_id, hold_state)
       values ($1, $2, $3, $4, 'top_up', $5, $6, $7, 'held')`,
          [s.business, randomUUID(), askId, runId, amount, currency, people.approver.personId],
        );
        await tx.query(
          `update public.planned_runs set state = 'planned' where business_id = $1 and id = $2`,
          [s.business, runId],
        );
        return 'accepted';
      })
      .catch((error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error ? error.code : error,
      );
    const [run] = await s.db.admin.execute<{ state: string }>(
      'select state from public.planned_runs where id = $1',
      [runId],
    );
    expect({ result, state: run?.state }).toEqual({ result: '23514', state: 'waiting_budget' });
  },
);
