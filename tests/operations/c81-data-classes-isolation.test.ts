// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the data-class register's refusals, its lock and its three crossings.
// Only a holder of `privacy:manage` sets a class; a change and a policy
// approval at once apply in one order under the register's lock; another
// business, another client in the same business and the agent under a live
// delegation never read or change alpha's classes; and a class's words reach
// no log, audit row, operation register row, refusal or other business's read.
// The world is `c81-data-classes-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { approveLegalVersion } from '../../packages/core-records/src/operations/legal-documents.ts';
import { setDataClass } from '../../packages/core-records/src/operations/data-classes.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  approve,
  classRows,
  clientToken,
  closeWorld,
  credential,
  dataClass,
  digestOf,
  draft,
  h,
  listed,
  openWorld,
  publish,
  readPolicy,
  releasePolicy,
  SET,
  set,
  setOk,
} from './c81-data-classes-world.ts';

const CANARY = 'CANARY-c81-data-class-7d40c3';

if (serverUrl === undefined) {
  console.warn(
    'operations/c81-data-classes-isolation: DATABASE_URL is unset, so nothing below ran.',
  );
}

const test = it.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl !== undefined) await openWorld('c81_data_classes_isolation');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

test('C81 data class change and approval at once: the approval waits for the change and is told the classes changed', async () => {
  const drafted = await draft();
  const actorId = h().world.ada.actorId as string;
  // Two connections, so the two transactions truly overlap: the first sets a
  // class and holds the register's lock for 300 ms, and the approval arrives.
  const wide = connect(h().world.db.appUrl, { source: 'runtime', max: 2 });
  const { operationId: _unused, ...change } = dataClass();
  const first = wide.withBusiness(h().world.alpha, async (tx) => {
    await setDataClass(tx, change, actorId);
    await tx.query('select pg_sleep(0.3)');
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  const second = wide.withBusiness(
    h().world.alpha,
    async (tx) => await approveLegalVersion(tx, drafted.versionId, digestOf(drafted.body), actorId),
  );
  const outcomes = await Promise.allSettled([first, second]).finally(
    async () => await wide.close(),
  );
  expect(outcomes).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: 'data-classes-changed' },
  ]);
});

test('C81 refusal privacy:manage: a holder of operations:read alone, a member and a client are refused the data classes, and nothing is written', async () => {
  const before = await classRows(h().world.alpha);
  for (const token of [h().world.noah.token, h().world.mia.token, clientToken()]) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await set(dataClass(), token);
    expect({ status: answer.status, code: answer.code }).toEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });
  }
  expect(await classRows(h().world.alpha)).toEqual(before);
});

test('C81 isolation: another business, another client and a delegated agent never read or change the data classes', async () => {
  const alphaClass = dataClass({ dataClass: `alpha only ${randomUUID()}` });
  await setOk(alphaClass);
  const alphaBefore = await classRows(h().world.alpha);

  // Another business: bravo's classes never reach alpha's policy, nor the
  // reverse, and bravo's change does not spend alpha's draft.
  const bravoClass = dataClass({ dataClass: `bravo only ${randomUUID()}` });
  await setOk(bravoClass, h().world.bea.token, 'bravo');
  const bravoPolicy = await releasePolicy(h().world.bea.token, 'bravo');
  expect(bravoPolicy.json['dataClasses']).toEqual([listed(bravoClass)]);
  const alphaDraft = await draft();
  await setOk(dataClass(), h().world.bea.token, 'bravo');
  expect((await approve(alphaDraft)).status).toBe(200);
  expect((await publish(alphaDraft.versionId)).status).toBe(200);
  expect((await readPolicy('alpha')).text).not.toContain(bravoClass.dataClass);
  expect(bravoPolicy.text).not.toContain(alphaClass.dataClass);
  const across = await set(dataClass(), h().world.bea.token, 'alpha');
  expect({ status: across.status, code: across.code }).toEqual({
    status: 403,
    code: 'AUTH_NO_MEMBERSHIP',
  });

  // Another client in the same business: a share does not reach the register.
  const client = await set(
    { ...alphaClass, operationId: randomUUID(), purpose: 'x' },
    clientToken(),
  );
  expect(client.status).toBe(403);
  expect(JSON.stringify(client.body)).not.toContain(alphaClass.dataClass);

  // Another person under a live delegation: the agent acting for Ada is refused.
  const agent = await call(h().world.api, agentPath('alpha', SET), dataClass(), {
    ...bearer(h().world.agent.token),
    [DELEGATION_HEADER]: credential(),
  });
  expect({ status: agent.status, code: agent.code }).toEqual({
    status: 403,
    code: 'DELEGATION_EXCLUDES_OPERATION',
  });
  expect(await classRows(h().world.alpha)).toEqual(alphaBefore);
});

const storedFor = async (business: string) =>
  await h().world.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'privacy.set_data_class'
         union all
         select to_jsonb(o)::text from public.operations o
          where command = 'privacy.set_data_class'`,
      ),
  );

test('C81 isolation: a class set in bravo, and text a refusal was sent, reach no log, audit row, operation register row, refusal or alpha read', async () => {
  const logged: string[] = [];
  const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(capture),
  );
  try {
    await setOk(
      dataClass({ dataClass: `class ${CANARY}`, purpose: CANARY }),
      h().world.bea.token,
      'bravo',
    );
    const answers = [
      await set(dataClass({ purpose: CANARY }), h().world.mia.token),
      await set(dataClass({ purpose: CANARY }), h().world.bea.token, 'alpha'),
      await set(dataClass({ purpose: CANARY, retention: '' })),
    ];
    for (const answer of answers) {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    await releasePolicy();
    expect((await readPolicy('alpha')).text).not.toContain(CANARY);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(CANARY);
  for (const business of [h().world.alpha, h().world.bravo]) {
    // oxlint-disable-next-line no-await-in-loop
    const stored = await storedFor(business);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
  }
});
