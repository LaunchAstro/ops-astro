// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, C41-A's part of the delegation crossing: a ready agent step
// on each of two onboardings the other Alpha person started. The agent picks
// one up under its delegating person's own delegation (the control); no
// delegation of the agent reaches the other (the crossing,
// api-1-isolation-delegation.ts). Seeded by the world's setup; made-up names
// only.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import { authorised, post } from './fixture.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  agentToken,
  api,
  approveOn,
  detail,
  fixture,
  labelAs,
  rows,
} from './api-1-isolation-world.ts';
import { asAgent, canonical } from './api-1-isolation-surfaces.ts';

export let foreignStep = '';
let ownStep = '';
let ownStepDelegation = '';

/** An onboarding the other person starts on a new client of its own: its ready agent step. */
async function welcomeOf(otherToken: string, name: string): Promise<string> {
  const asOther = async (path: string, body: Record<string, unknown>) =>
    detail(
      (
        await post(
          api,
          `/api/b/alpha${path}`,
          { operationId: randomUUID(), ...body },
          authorised(otherToken),
        )
      ).body,
    );
  const client = await asOther('/record/create', { type: 'client', fields: { name } });
  const started = await asOther('/onboarding/start', {
    clientId: client['recordId'],
    templateKey: 'standard',
  });
  const steps = (started['steps'] ?? []) as readonly { key: string; taskId: string }[];
  const id = steps.find((one) => one.key === 'welcome-email')?.taskId;
  if (id === undefined) throw new Error(JSON.stringify(started));
  return id;
}

/** The other person's two onboardings, and the agent's pickup of its own step. */
export async function seedSteps(
  otherPerson: Member,
  otherToken: string,
  alphaToken: string,
): Promise<void> {
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, otherPerson, 'write', WHOLE_BUSINESS, false, 'record');
  });
  foreignStep = await welcomeOf(otherToken, 'Made-up Other Onboarding');
  labelAs(foreignStep, '<other task>');
  ownStep = await welcomeOf(otherToken, 'Made-up Own Onboarding');
  labelAs(ownStep, '<delegated step>');
  const [held] = await fixture.db.admin.execute<{ revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [fixture.business, ownStep],
  );
  const reservationId = await approveOn(
    alphaToken,
    ownStep,
    Number(held?.revision),
    'onboarding_step',
  );
  const picked = await post(
    api,
    '/api/a/b/alpha/task/pickup',
    { operationId: randomUUID(), reservationId },
    authorised(agentToken),
  );
  if (picked.status !== 200) throw new Error(JSON.stringify(picked));
  ownStepDelegation = String(detail(picked.body)['credential']);
}

/** The other person's onboarding: its steps, the comments and inbox items on each. */
export async function foreignOnboarding(): Promise<unknown> {
  return await fixture.db.admin.execute(
    `select s.step_key, s.state, s.failures, o.state as onboarding, o.revision::text,
            (select count(*) from public.records c
              where c.business_id = $1 and c.data ->> 'task' = s.task_id::text)::int as comments,
            (select count(*) from public.inbox_items i
              where i.business_id = $1 and i.subject_record_id = s.task_id)::int as items
       from public.onboarding_steps s
       join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
      where s.business_id = $1
        and s.onboarding_id = (select onboarding_id from public.onboarding_steps
                                where business_id = $1 and task_id = $2)
      order by s.position`,
    [fixture.business, foreignStep],
  );
}

export function ownStepControl(): void {
  it('API-1 isolation: the agent records the result of its own delegated onboarding step', async () => {
    const row = rows.find((one) => one.command === 'onboarding.step_result') as CatalogueRow;
    const body = { recordId: ownStep, outcome: 'done', result: 'made-up' };
    // The CLI's call closes the step; the API's, under the same operation id, replays it.
    const heard = await asAgent(row, 'alpha', body, ownStepDelegation);
    expect(
      heard.map((one) => [one.status, one.code, canonical(one.body)]),
      JSON.stringify(heard),
    ).toStrictEqual(heard.map(() => [200, undefined, canonical(heard[0]?.body)]));
    expect(heard).toHaveLength(2);
    const [step] = await fixture.db.admin.execute<{ state: string; comments: number }>(
      `select s.state, (select count(*) from public.records c
                         where c.business_id = $1 and c.data ->> 'task' = $2)::int as comments
         from public.onboarding_steps s where s.business_id = $1 and s.task_id = $2`,
      [fixture.business, ownStep],
    );
    expect(step).toEqual({ state: 'done', comments: 1 });
  }, 60_000);
}
