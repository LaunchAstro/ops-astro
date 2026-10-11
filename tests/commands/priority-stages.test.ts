// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { rankCommand, type RankCoreWorld } from '../reads/task-rank-core-world.ts';
import {
  KEY,
  priorityWorld,
  priorityDeclaration,
  priorityApplied,
  priorityRow,
  readPriority,
  setPriority,
} from './priority-stages-support.ts';

let world: RankCoreWorld | undefined;
function here(): RankCoreWorld {
  if (world === undefined) throw new Error('P10 owned database is not prepared');
  return world;
}
beforeAll(async () => {
  world = await priorityWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

it('fresh install exposes an operation-owned JSON array, empty by default', async () => {
  const w = here();
  expect(await priorityRow(w)).toMatchObject({
    key: KEY,
    valueType: 'stage_ids',
    value: [],
    writeMode: 'operation',
    owningOperations: ['settings.set_priority_stages'],
    visibilityClass: 'internal',
    revision: 1,
    updatedByActorId: null,
  });
  expect(await readPriority(w)).toMatchObject({ value: [], revision: 1 });
  const rows = await w.db.app.withBusiness(w.business, (tx) =>
    tx.query<{ readonly kind: string }>(
      'select jsonb_typeof(value) as kind from business_settings where business_id = $1 and key = $2',
      [tx.businessId, KEY],
    ),
  );
  expect(Array.from(rows)).toStrictEqual([{ kind: 'array' }]);
  expect(priorityDeclaration()).toMatchObject({
    collection: 'settings',
    action: 'manage',
    agent: 'never',
  });
});

it('canonical write/read/clear and reinstall preserve typed configuration and scalar rows', async () => {
  const w = here();
  priorityApplied(await rankCommand(w, { command: 'settings.set_retention_window', value: 37 }));
  const scalar = await w.db.app.withBusiness(w.business, (tx) =>
    readBusinessSetting(tx, 'retention_window_days'),
  );
  const applied = priorityApplied(
    await setPriority(w, ['advocacy', 'trust'], (await readPriority(w)).revision),
  );
  expect(await readPriority(w)).toMatchObject({
    value: ['trust', 'advocacy'],
    revision: applied.revision,
    updatedByActorId: w.owner.actorId,
  });
  const configured = await priorityRow(w);
  await w.db.app.withBusiness(w.business, installBusinessSettings);
  expect(await priorityRow(w)).toStrictEqual(configured);
  const retainedScalar = await w.db.app.withBusiness(w.business, (tx) =>
    readBusinessSetting(tx, 'retention_window_days'),
  );
  expect(retainedScalar).toStrictEqual(scalar);
  const cleared = priorityApplied(await setPriority(w, [], applied.revision ?? undefined));
  expect(await readPriority(w)).toMatchObject({ value: [], revision: cleared.revision });
});

it.each([
  { label: 'null', value: null },
  { label: 'duplicate journey', value: ['trust', 'trust'] },
  { label: 'internal Ops', value: ['ops'] },
  { label: 'foreign non-catalogue ID', value: ['44444444-4444-4444-8444-444444444444'] },
])('refuses $label without changing configuration', async ({ value }) => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  const before = await priorityRow(w);
  const operationId = randomUUID();
  const revision = (await readPriority(w)).revision;
  const answer = await setPriority(w, value, revision, w.owner, w.business, operationId);
  expect(answer).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
  expect(await priorityRow(w)).toStrictEqual(before);
  const audits = await w.db.app.withBusiness(w.business, readAuditEvents);
  expect(audits.filter((one) => one.operation_id === operationId)).toMatchObject([
    {
      command: 'settings.set_priority_stages',
      outcome: 'refused',
      refusal_code: 'FIELD_VALUE_INVALID',
    },
  ]);
});

it('a person without settings:manage cannot change another authorised value', async () => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  const before = await priorityRow(w);
  expect(await setPriority(w, ['sales'], (await readPriority(w)).revision, w.nobody)).toMatchObject(
    {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
    },
  );
  expect(await priorityRow(w)).toStrictEqual(before);
});

it('a stale administrator proposal cannot replace the winner or advance its revision', async () => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  const before = await readPriority(w);
  const winner = priorityApplied(await setPriority(w, ['sales'], before.revision));
  const held = await priorityRow(w);
  expect(await setPriority(w, ['advocacy'], before.revision)).toMatchObject({
    refused: true,
    code: 'VERSION_STALE',
  });
  expect(await priorityRow(w)).toStrictEqual(held);
  expect(await readPriority(w)).toMatchObject({ value: ['sales'], revision: winner.revision });
});

it('the exact setting operation replays once; another body cannot reuse its identity', async () => {
  const w = here();
  const operationId = randomUUID();
  const revision = (await readPriority(w)).revision;
  const applied = priorityApplied(
    await setPriority(w, ['trust'], revision, w.owner, w.business, operationId),
  );
  const held = await priorityRow(w);
  expect(await setPriority(w, ['trust'], revision, w.owner, w.business, operationId)).toStrictEqual(
    applied,
  );
  expect(await setPriority(w, ['sales'], revision, w.owner, w.business, operationId)).toMatchObject(
    { refused: true, code: 'OPERATION_ID_REUSED' },
  );
  expect(await priorityRow(w)).toStrictEqual(held);
  const audits = await w.db.app.withBusiness(w.business, readAuditEvents);
  const own = audits.filter((one) => one.operation_id === operationId);
  expect(own.map((one) => one.outcome)).toStrictEqual(['applied', 'replayed', 'refused']);
  expect(own.every((one) => one.command === 'settings.set_priority_stages')).toBe(true);
  expect(own[1]?.payload_digest).toBe(own[0]?.payload_digest);
  expect(own[2]?.payload_digest).not.toBe(own[0]?.payload_digest);
});

it('a proposal naming no revision applies, as the other settings do', async () => {
  const w = here();
  const applied = priorityApplied(await setPriority(w, ['enquiries'], undefined));
  expect(await readPriority(w)).toMatchObject({
    value: ['enquiries'],
    revision: applied.revision,
  });
});
