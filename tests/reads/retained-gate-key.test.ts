// SPDX-License-Identifier: AGPL-3.0-only
//
// A chain that spans a gate key change reads once the retired key is retained (#2265).
//
// Staging's alpha holds seq 1-9 signed under `staging-gate-1` and seq 10-11
// under `staging-gate-2`, and `task.read` of any task with a decision there
// answered DECISION_INTEGRITY: the read verified from seq 1 with the one
// configured key. Here the deployment's key moves on after a decision, the
// read fails as staging's did, and with the older key in `GATE_RETAINED_KEYS`
// both decisions read, each verified under the key its own row names. The
// retained key is still checked: the right id with the wrong secret fails.
// The setting's own refusals are `tests/runtime/gate-retained-keys.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-commands/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-commands/src/reads/verified-decisions.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

/** A task, a proposal on it and an approval, all through the production path. */
async function decided(world: World): Promise<string> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision under a key that moves on ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const revision = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, taskId],
  );
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: Number(revision[0]?.revision ?? '0'),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  const approved = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId: String(detail['gateId']),
    versionId: String(detail['versionId']),
    decision: 'approve',
    note: 'approved as proposed',
  });
  expect(approved.code, 'decide').toBe('ok');
  return taskId;
}

/** Through the API and directly: `code` is `ok` for a fault too, so the status says it read. */
async function readsWhole(world: World, taskId: string): Promise<void> {
  const answer = await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
  expect(answer.status, 'task.read').toBe(200);
  expect(answer.body['task']).toBeDefined();
  const direct = await world.db.app.withBusiness(
    world.alpha,
    async (tx) => await readTaskProposals(tx, taskId),
  );
  expect(direct[0]?.decisions).toHaveLength(1);
}

async function failsIntegrity(world: World, taskId: string, where: RegExp): Promise<void> {
  const answer = await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
  expect(answer.status).toBeGreaterThanOrEqual(500);
  expect(answer.body['task']).toBeUndefined();
  let failure: unknown = null;
  try {
    await world.db.app.withBusiness(world.alpha, async (tx) => await readTaskProposals(tx, taskId));
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(DecisionIntegrityError);
  expect((failure as Error).message).toMatch(where);
}

if (serverUrl === undefined) {
  console.warn('reads/retained-gate-key: DATABASE_URL is unset, so nothing below ran.');
}

const NAMES = ['GATE_SIGNING_KEY_ID', 'GATE_SIGNING_SECRET', 'GATE_RETAINED_KEYS'] as const;

describe.skipIf(serverUrl === undefined)('a chain across a gate key change', () => {
  let world: World | undefined;
  const saved = NAMES.map((name) => process.env[name]);

  afterEach(async () => {
    for (const [index, name] of NAMES.entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await world?.close();
    world = undefined;
  });

  it('fails as staging did, then reads with the retired key retained, and only with its own secret', async () => {
    world = await createWorld('vretain');
    const older = {
      id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
      secret: process.env['GATE_SIGNING_SECRET'] ?? '',
    };
    const before = await decided(world);
    process.env['GATE_SIGNING_KEY_ID'] = `${older.id}-next`;
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    delete process.env['GATE_RETAINED_KEYS'];
    await failsIntegrity(world, before, /seq 1: unknown signing key/u);

    process.env['GATE_RETAINED_KEYS'] = JSON.stringify([older]);
    await readsWhole(world, before);
    const after = await decided(world);
    const ids = await world.db.admin.execute<{ readonly signing_key_id: string }>(
      'select signing_key_id from public.gate_decisions where business_id = $1 order by seq',
      [world.alpha],
    );
    // The new link is signed with the current key, never the retained one.
    expect(ids.map((row) => row.signing_key_id)).toStrictEqual([older.id, `${older.id}-next`]);
    await readsWhole(world, after);

    process.env['GATE_RETAINED_KEYS'] = JSON.stringify([{ id: older.id, secret: randomUUID() }]);
    await failsIntegrity(world, after, /seq 1: signature does not verify/u);
  }, 60_000);
});
