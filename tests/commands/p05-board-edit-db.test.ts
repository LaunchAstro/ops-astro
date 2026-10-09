// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from './fixture.ts';
import { timeWorld, type TimeWorld } from './time-world.ts';
import type { BoardEditCustody } from '../../apps/web/src/screens/projects/board-edit-custody.ts';
import type { TaskDetail } from '../../packages/core-wire/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  VARIANTS,
  type Variant,
  intent,
  task,
  revoke,
  effects,
  delivery,
} from './p05-board-edit-db-support.ts';
async function restore(w: TimeWorld): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.taskOnly, 'write');
  });
}

function settlement(custody: BoardEditCustody): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = custody.settled(() => {
      unsubscribe();
      resolve();
    });
  });
}

function assertRegistered(
  proof: Awaited<ReturnType<typeof effects>>,
  id: string,
  variant: Variant,
  revision: number,
): void {
  expect(proof.operations).toHaveLength(1);
  expect(proof.operations[0]).toMatchObject({
    command: intent(id, variant).command,
    result: { command: intent(id, variant).command, recordId: id, revision },
  });
  if (variant === 'reopen')
    expect(proof.operations[0]?.result).toMatchObject({
      detail: { reason: 'Reopened from the Projects board' },
    });
}

/** Assert the submitted operand through the real authorised read projection. */
function assertApplied(row: Awaited<ReturnType<typeof task>>, variant: Variant): void {
  switch (variant) {
    case 'title':
      expect(row.title).toBe('Submitted canonical board edit');
      return;
    case 'due':
      expect(row.due).toBeNull();
      return;
    case 'estimate':
      expect(row.estimateMinutes).toBeNull();
      return;
    case 'stage':
      expect(row.stage).toBe('awareness');
      return;
    case 'complete':
      expect(row.state?.key).toBe('complete');
      expect(row.state?.machineCategory).toBe('completed');
      expect(row.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      return;
    case 'reopen':
      expect(row.state?.key).toBe('needs_review');
      expect(row.state?.machineCategory).toBe('unstarted');
      expect(row.completedAt).toBeNull();
  }
}
async function fresh(w: TimeWorld, variant: Variant): Promise<TaskDetail> {
  const made = await w.as(w.alpha, w.taskOnly, {
    command: 'task.create',
    fields: { title: 'Canonical board recovery', due: '2026-10-10', estimated_minutes: 30 },
    stateKey: 'active',
  });
  if (isCommandRefusal(made) || typeof made.recordId !== 'string')
    throw new Error('Canonical fixture create refused');
  const id = made.recordId;
  if (variant === 'reopen') {
    const row = await task(w, id);
    const complete = await w.as(w.alpha, w.taskOnly, {
      command: 'task.complete',
      recordId: id,
      expectedRevision: row.revision,
    });
    if (isCommandRefusal(complete)) throw new Error('Canonical fixture completion refused');
  }
  const row = await task(w, id);
  expect(row.title).toBe('Canonical board recovery');
  expect(row.due).toBe('2026-10-10T00:00:00.000Z');
  expect(row.estimateMinutes).toBe(30);
  expect(row.stage).toBeNull();
  if (variant === 'reopen') assertApplied(row, 'complete');
  else {
    expect(row.completedAt).toBeNull();
    expect(row.state?.machineCategory).toBe('started');
  }
  return row;
}

async function lostAfter(w: TimeWorld, variant: Variant): Promise<void> {
  const row = await fresh(w, variant);
  const transport = delivery(w, 'stored');
  const done = settlement(transport.custody);
  expect(transport.custody.choose(intent(row.id, variant), row.revision)).toBe(true);
  await done;
  const original = transport.writes[0]!;
  const operationId = String(original.body['operationId']);
  const applied = await task(w, row.id);
  expect(applied.revision).toBe(row.revision + 1);
  assertApplied(applied, variant);
  const advance = await w.as(w.alpha, w.taskOnly, {
    command: 'task.update',
    recordId: row.id,
    expectedRevision: applied.revision,
    fields: { title: 'Later independent edit' },
  });
  expect(isCommandRefusal(advance)).toBe(false);
  const current = await task(w, row.id);
  const hydrated = transport.copy();
  expect(transport.writes).toHaveLength(1);
  await hydrated.retry(row.id);
  expect(transport.writes[1]).toStrictEqual(original);
  expect(await task(w, row.id)).toStrictEqual(current);
  const proof = await effects(w, operationId);
  assertRegistered(proof, row.id, variant, row.revision + 1);
  expect(proof.operations).toHaveLength(1);
  expect(proof.audit.map((event) => event.outcome)).toEqual(['applied', 'replayed']);
  expect(
    proof.audit.every(
      (event) => event.command === original.command && event.operation_id === operationId,
    ),
  ).toBe(true);
}

async function neverForwarded(w: TimeWorld, variant: Variant): Promise<void> {
  const row = await fresh(w, variant);
  const transport = delivery(w, 'unreached');
  const done = settlement(transport.custody);
  expect(transport.custody.choose(intent(row.id, variant), row.revision)).toBe(true);
  await done;
  const original = transport.writes[0]!;
  const operationId = String(original.body['operationId']);
  expect(await effects(w, operationId)).toEqual({ operations: [], audit: [] });
  expect((await task(w, row.id)).revision).toBe(row.revision);
  expect(await task(w, row.id)).toStrictEqual(row);
  await transport.custody.retry(row.id);
  expect(transport.writes[1]).toStrictEqual(original);
  const applied = await task(w, row.id);
  expect(applied.revision).toBe(row.revision + 1);
  assertApplied(applied, variant);
  const proof = await effects(w, operationId);
  assertRegistered(proof, row.id, variant, row.revision + 1);
  expect(proof.operations).toHaveLength(1);
  expect(proof.audit.map((event) => event.outcome)).toEqual(['applied']);
}

async function authorityRenewed(w: TimeWorld, variant: Variant): Promise<void> {
  const row = await fresh(w, variant);
  const transport = delivery(w, 'stored');
  const done = settlement(transport.custody);
  expect(transport.custody.choose(intent(row.id, variant), row.revision)).toBe(true);
  await done;
  const original = transport.writes[0]!;
  const operationId = String(original.body['operationId']);
  const current = await task(w, row.id);
  expect(current.revision).toBe(row.revision + 1);
  assertApplied(current, variant);
  await revoke(w);
  try {
    await transport.custody.retry(row.id);
    expect(transport.writes[1]).toStrictEqual(original);
    expect(transport.custody.snapshot().holds.get(row.id)?.entry.knowledge).toBe('unresolved');
    expect(transport.custody.snapshot().holds.get(row.id)?.notice).toContain(
      'may already have been applied',
    );
    const proof = await effects(w, operationId);
    assertRegistered(proof, row.id, variant, row.revision + 1);
    expect(proof.operations).toHaveLength(1);
    expect(proof.audit.map((event) => event.outcome)).toEqual(['applied', 'refused']);
  } finally {
    await restore(w);
  }
  await transport.custody.retry(row.id);
  expect(transport.writes[2]).toStrictEqual(original);
  expect(await task(w, row.id)).toStrictEqual(current);
  const proof = await effects(w, operationId);
  assertRegistered(proof, row.id, variant, row.revision + 1);
  expect(proof.audit.map((event) => event.outcome)).toEqual(['applied', 'refused', 'replayed']);
  expect(transport.custody.snapshot().holds.has(row.id)).toBe(false);
}

async function rolledBack(w: TimeWorld): Promise<void> {
  const row = await fresh(w, 'title');
  const transport = delivery(w, 'rollback');
  const done = settlement(transport.custody);
  expect(transport.custody.choose(intent(row.id, 'title'), row.revision)).toBe(true);
  await done;
  const original = transport.writes[0]!;
  const operationId = String(original.body['operationId']);
  expect(transport.rollbackChecks).toStrictEqual([
    { command: original.command, operationId, recordId: row.id, revision: row.revision + 1 },
  ]);
  expect(await effects(w, operationId)).toEqual({ operations: [], audit: [] });
  expect((await task(w, row.id)).revision).toBe(row.revision);
  expect(await task(w, row.id)).toStrictEqual(row);
  await transport.custody.retry(row.id);
  expect(transport.writes[1]).toStrictEqual(original);
  const applied = await task(w, row.id);
  expect(applied.revision).toBe(row.revision + 1);
  assertApplied(applied, 'title');
  const proof = await effects(w, operationId);
  assertRegistered(proof, row.id, 'title', row.revision + 1);
  expect(proof.operations).toHaveLength(1);
  expect(proof.audit.map((event) => event.outcome)).toEqual(['applied']);
}

async function oppositeTransition(w: TimeWorld, variant: 'complete' | 'reopen'): Promise<void> {
  const row = await fresh(w, variant);
  const transport = delivery(w, 'stored');
  const done = settlement(transport.custody);
  expect(transport.custody.choose(intent(row.id, variant), row.revision)).toBe(true);
  await done;
  const original = transport.writes[0]!;
  const applied = await task(w, row.id);
  expect(applied.revision).toBe(row.revision + 1);
  assertApplied(applied, variant);
  const opposite = variant === 'complete' ? 'task.reopen' : 'task.complete';
  const changed = await w.as(w.alpha, w.taskOnly, {
    command: opposite,
    recordId: row.id,
    expectedRevision: applied.revision,
    ...(opposite === 'task.reopen' ? { reason: 'Later canonical reopening' } : {}),
  });
  expect(isCommandRefusal(changed)).toBe(false);
  const current = await task(w, row.id);
  expect(current.revision).toBe(applied.revision + 1);
  assertApplied(current, variant === 'complete' ? 'reopen' : 'complete');
  await transport.custody.retry(row.id);
  expect(transport.writes[1]).toStrictEqual(original);
  expect(await task(w, row.id)).toStrictEqual(current);
  const proof = await effects(w, String(original.body['operationId']));
  assertRegistered(proof, row.id, variant, row.revision + 1);
  expect(proof.audit.map((event) => event.outcome)).toEqual(['applied', 'replayed']);
  expect(proof.operations).toHaveLength(1);
}

const url = databaseUrlFromEnvironment();
describe.skipIf(url === undefined)('closed board edits through canonical transactions', () => {
  let w: TimeWorld;
  beforeAll(async () => {
    w = await timeWorld('p05be');
  }, 90000);
  afterAll(async () => {
    await w?.db.drop();
  });
  it.each(VARIANTS)(
    '%s lost-after retains exact envelope across journal restoration and a later row revision',
    (variant) => lostAfter(w, variant),
  );
  it.each(VARIANTS)(
    '%s never-forwarded sends the original operation once on explicit Retry',
    (variant) => neverForwarded(w, variant),
  );
  it.each(VARIANTS)(
    '%s applied replay is withheld under current authority and recovered with the same identity after renewal',
    (variant) => authorityRenewed(w, variant),
  );
  it('a rolled-back canonical handler leaves no operation/domain audit and exact Retry applies once', () =>
    rolledBack(w));
  it.each(['complete', 'reopen'] as const)(
    'old %s replay cannot repeat a later opposite transition',
    (variant) => oppositeTransition(w, variant),
  );
});
