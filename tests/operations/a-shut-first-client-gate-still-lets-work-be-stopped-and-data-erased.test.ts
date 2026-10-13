// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the first-client gate shut on a real-data installation after go-live,
// one item reopened. The gate keeps new client data out, and it must never
// keep a person from stopping work or erasing data: cancelling a run, revoking
// an agent's delegation or mandate, ending a run at its budget stop, writing
// off a spend, and trashing and purging a task each still run. Each command's
// body is prepared while the installation is made-up, as the readiness proof
// prepares its own (`s0-5-readiness.test.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';

if (serverUrl === undefined) {
  console.warn('operations/a-shut-first-client-gate: DATABASE_URL is unset, so nothing ran.');
}

const STOPS = [
  'task.cancel',
  'delegation.revoke',
  'mandate.revoke',
  'run.end_at_budget_stop',
  'budget.write_off',
  'task.trash',
  'task.purge',
] as const;

let harness: Harness;
const bodies = new Map<string, Record<string, unknown>>();

const admin = async (sql: string, params: unknown[] = []): Promise<void> => {
  await harness.world.db.admin.execute(sql, params);
};

/** A live delegation to revoke: the positive recipe has none. */
async function delegationBody(): Promise<Record<string, unknown>> {
  const task = await harness.freshTask(`a stop under a shut gate ${randomUUID()}`);
  const decided = await harness.reserve(task, 'draft_the_gate_reply');
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  return { delegationId: (picked.body['detail'] as Record<string, unknown>)['delegationId'] };
}

async function prepare(): Promise<void> {
  harness = await createHarness('s05_stops');
  for (const name of STOPS) {
    const declaration = COMMAND_SURFACE.find((each) => each.name === name);
    if (declaration === undefined) throw new Error(`${name} is not in the catalogue`);
    /* eslint-disable no-await-in-loop -- one fixture after the other, on one world */
    if (name === 'delegation.revoke') {
      bodies.set(name, await delegationBody());
      continue;
    }
    const prepared = await harness.positiveBody(declaration);
    /* eslint-enable no-await-in-loop */
    if ('exception' in prepared) throw new Error(`${name}: ${prepared.exception}`);
    bodies.set(name, { ...prepared.body });
  }
  // Go live with every item done, then reopen one: the gate is shut.
  for (const item of GATE_ITEMS) {
    const { evidence, statement } = gateRecordBody(item);
    // eslint-disable-next-line no-await-in-loop
    await admin(
      `insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)
        on conflict (item) do nothing`,
      [item, evidence, statement ?? null],
    );
  }
  await admin(`update ops.installation set mode = 'real'`);
  await admin(`delete from ops.gate_items where item = 'security-pass'`);
}

describe.skipIf(serverUrl === undefined)('a shut first-client gate', () => {
  beforeAll(prepare, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 a shut first-client gate still lets a person stop work, revoke authority and erase a task', async () => {
    const shutOut = await harness.asPerson('task.create', { fields: { title: 'new data' } });
    expect([shutOut.status, shutOut.code], 'new client data waits').toStrictEqual([
      409,
      'GATE_SHUT',
    ]);
    const answered: string[] = [];
    for (const name of STOPS) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asPerson(name, bodies.get(name) ?? {});
      answered.push(`${name}: ${answer.status} ${answer.code}`);
    }
    expect(answered).toStrictEqual(STOPS.map((name) => `${name}: 200 ok`));
  }, 300_000);
});
