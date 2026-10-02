// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 isolation over the route: `harness.read` is a new endpoint, so the
// trigger read's crossings run again through the real API boundary. Each
// crossing has its status, a stored canary (the task's title and a reading no
// other run has) checked in every body, refusals included, and a positive
// control: another business; another client in the same business; a person
// with no `task:read`; a client or contractor holding `task:read` (the read is
// the team's); an agent under a live delegation on the very run.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER, PREFIX } from '../../packages/core-wire/src/index.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { noDatabase, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { shapedWork } from './aw-12-world.ts';
import { harnessOver, useHarnessRoute, type Answer } from './aw-12-route-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw12ri');
useHarnessRoute();

/** A reading no other run in the world has, so its figure is a canary of its own. */
const CANARY_UNITS = 31_337;

const clean = (answer: Answer, ...canaries: string[]): void => {
  const text = JSON.stringify(answer.body);
  for (const canary of [...canaries, String(CANARY_UNITS)]) expect(text).not.toContain(canary);
  expect(answer.body).not.toHaveProperty('harness');
};

const reads = (units: number) => ({
  status: 200,
  body: {
    ok: true,
    harness: expect.objectContaining({
      figures: expect.objectContaining({ reading: expect.objectContaining({ units }) }),
    }),
  },
});

/** A member of `role`, outside the team, granted task:read on `taskId` alone, asking twice. */
async function asOutsider(role: string, taskId: string, runId: string) {
  const outsider = await enrol(w.s.db.app, w.s.business, `aw12r-${role}`);
  await w.s.db.admin.execute(
    `update public.memberships set role_key = $3 where business_id = $1 and person_id = $2`,
    [w.s.business, outsider.personId, role],
  );
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, outsider, 'read', { kind: 'record', id: taskId });
  });
  const refused = await harnessOver(w.s, outsider, runId);
  return { refused, madeUp: await harnessOver(w.s, outsider, randomUUID()) };
}

/** `task.read` on `taskId` on the agent route, as the run's own agent on `credential`. */
async function taskReadAsAgent(taskId: string, credential: string): Promise<Answer> {
  const api = createApi({
    database: w.s.db.app,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: createBusinessResolver(w.s.db.admin),
    executeRead,
    executeCommand,
    executeAgentCommand,
  });
  const [row] = await w.s.db.admin.execute<{ readonly key: string }>(
    'select key from public.businesses where id = $1',
    [w.s.business],
  );
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.agent}${String(row?.key)}${pathOf('task.read')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor(w.s.agent.subject)}`,
        [DELEGATION_HEADER]: credential,
      },
      body: JSON.stringify({ operationId: randomUUID(), recordId: taskId }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Answer['body'] };
}

it('AW-12 harness read isolation: another business’s run is NOT_FOUND over the route', async () => {
  const canary = `aw12r-alpha-canary-${randomUUID()}`;
  const alpha = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const bravo = await shapedWork(w.bravo, [100], w.bravoHelper);

  // Bravo's member naming alpha's run in bravo: not there.
  const crossed = await harnessOver(w.bravo, w.bravo.decider, alpha.runId);
  expect(crossed).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  // A made-up run is the same answer, byte for byte: the refusal tells nothing apart.
  const madeUp = await harnessOver(w.bravo, w.bravo.decider, randomUUID());
  expect(JSON.stringify(madeUp)).toBe(JSON.stringify(crossed));
  // Alpha's member on bravo's address: no standing there at all.
  const carried = await harnessOver(w.bravo, w.s.decider, alpha.runId);
  expect(carried.body).toMatchObject({ refused: true });
  for (const answer of [crossed, carried]) clean(answer, canary, alpha.runId, alpha.work.taskId);
  // Controls: each reads its own over the route.
  expect(await harnessOver(w.s, w.s.decider, alpha.runId)).toMatchObject(reads(CANARY_UNITS));
  expect(await harnessOver(w.bravo, w.bravo.decider, bravo.runId)).toMatchObject(reads(100));
});

it('AW-12 harness read isolation: another client’s run in the same business is NOT_FOUND over the route', async () => {
  const canary = `aw12r-client-canary-${randomUUID()}`;
  const one = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const two = await shapedWork(w.s, [200], w.helper);
  const [clientOne, clientTwo] = [randomUUID(), randomUUID()];
  for (const [task, client] of [
    [one.work.taskId, clientOne],
    [two.work.taskId, clientTwo],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one task at a time
    await w.s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $3::text)
        where business_id = $1 and id = $2`,
      [w.s.business, task, client],
    );
  }
  // Client two's account manager: task:read on client two, never on a task or the business.
  const manager = await enrol(w.s.db.app, w.s.business, 'aw12r-manager');
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, manager, 'read', { kind: 'party', id: clientTwo });
  });

  const wrongClient = await harnessOver(w.s, manager, one.runId);
  expect(wrongClient).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  clean(wrongClient, canary, clientOne, one.runId, one.work.taskId);
  // Control: the client grant reads client two's run.
  expect(await harnessOver(w.s, manager, two.runId)).toMatchObject(reads(200));
});

it('AW-12 harness read isolation: a person without task:read gets SCOPE_NOT_GRANTED over the route', async () => {
  const canary = `aw12r-person-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const colleague = await enrol(w.s.db.app, w.s.business, 'aw12r-colleague');

  const ungranted = await harnessOver(w.s, colleague, mine.runId);
  expect(ungranted).toMatchObject({ status: 403, body: { code: 'SCOPE_NOT_GRANTED' } });
  // The same answer for a run that is not there: the refusal says nothing about the run.
  const missing = await harnessOver(w.s, colleague, randomUUID());
  expect(missing.body).toStrictEqual(ungranted.body);
  clean(ungranted, canary, mine.runId, mine.work.taskId);
  // Control: once granted task:read, the same person reads it.
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, colleague, 'read', { kind: 'record', id: mine.work.taskId });
  });
  expect(await harnessOver(w.s, colleague, mine.runId)).toMatchObject(reads(CANARY_UNITS));
});

it('AW-12 harness read isolation: a client or contractor holding task:read on the task gets SCOPE_NOT_GRANTED over the route', async () => {
  const canary = `aw12r-outsider-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  for (const role of ['client', 'contractor']) {
    // eslint-disable-next-line no-await-in-loop -- one role at a time
    const { refused, madeUp } = await asOutsider(role, mine.work.taskId, mine.runId);
    expect(refused, role).toMatchObject({ status: 403, body: { code: 'SCOPE_NOT_GRANTED' } });
    // The same caller on a made-up run: the same bytes, so the refusal tells nothing apart.
    expect(JSON.stringify(madeUp), role).toBe(JSON.stringify(refused));
    clean(refused, canary, mine.runId, mine.work.taskId);
  }
  // Control: the decider, on the team, reads the same run.
  expect(await harnessOver(w.s, w.s.decider, mine.runId)).toMatchObject(reads(CANARY_UNITS));
});

it('AW-12 harness read isolation: an agent under a live delegation on the run is refused on the agent route', async () => {
  const canary = `aw12r-agent-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const credential = String(mine.work.picked['credential']);

  // The run's own agent, its delegation on this very run live: no agent reads the result.
  const agent = await harnessOver(w.s, { presented: w.s.agent }, mine.runId, credential);
  expect(agent).toMatchObject({
    status: 403,
    body: { code: 'DELEGATION_EXCLUDES_OPERATION', names: ['harness.read'] },
  });
  // Control: that agent and credential are live on the agent route: its own task reads.
  expect(await taskReadAsAgent(mine.work.taskId, credential)).toMatchObject({
    status: 200,
    body: { command: 'task.read', recordId: mine.work.taskId },
  });
  // Its login on the person route is no member's either.
  const asPerson = await harnessOver(w.s, { presented: w.s.agent }, mine.runId);
  expect(asPerson.body).toMatchObject({ refused: true });
  for (const answer of [agent, asPerson]) clean(answer, canary, mine.runId, credential);
  // Control: the person the delegation draws on reads it.
  expect(await harnessOver(w.s, w.s.decider, mine.runId)).toMatchObject(reads(CANARY_UNITS));
});
