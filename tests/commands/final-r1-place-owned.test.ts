// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, the placement lane's continuation: the five owning
// operations need a field map, as `task.update` does (R1-THERMO-14).
//
// `task.assign`, `task.triage`, `task.set_stage`, `task.set_party` and
// `task.set_audience` all write through `writeOwnedFields`, which read `fields`
// with `Object.keys` before anything checked it was a map. An absent or null
// `fields` was a TypeError answered 503; a string or an array was taken apart
// by index and refused `FIELD_UNKNOWN` naming `0`. Each is now
// `FIELD_VALUE_INVALID` 422 naming `fields`, and nothing is written (API.md, "An
// absent or mistyped operand is refused by name, not answered as a fault").

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1-place-owned: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

const OWNING = [
  'task.assign',
  'task.triage',
  'task.set_stage',
  'task.set_party',
  'task.set_audience',
] as const;

const SHAPES = [
  ['absent', {}],
  ['null', { fields: null }],
  ['a string', { fields: 'x' }],
  ['an array', { fields: ['title'] }],
] as const;

const CASES = OWNING.flatMap((command) =>
  SHAPES.map(([label, operand]) => [command, label, operand] as const),
);

const refusal = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: answer };

describe.skipIf(serverUrl === undefined)('final review round 1: the owning operations', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  const run = async (command: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, business, worker.presented, 'api', command as unknown as Request);

  const revisionOf = async (recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly revision: string }>(
        `select revision::text as revision from records where business_id = $1 and id = $2`,
        [business, recordId],
      );
      return Number(rows[0]?.revision);
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'final-r1-place-owned');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'owner');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'assign');
      await grantTo(tx, worker, 'share');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it.each(CASES)(
    '%s refuses fields %s by name and writes nothing',
    async (command, _l, operand) => {
      const made = await run({
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'owned' },
      });
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      const task = made.recordId ?? '';
      const before = await revisionOf(task);

      const answer = await run({
        command,
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: before,
        ...operand,
      });
      expect(refusal(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['fields'] });
      expect(await revisionOf(task)).toBe(before);
    },
  );
});
