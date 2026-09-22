// SPDX-License-Identifier: AGPL-3.0-only
//
// `command_shape`: the invariant test T1f is split against.
//
// The specification states it in three halves (section 6, T1f): every mutating
// command requires an `operation_id` and an `expected_revision`; the same
// identity with the same payload replays; the same identity with a different
// payload is refused. It passes only with T1c, T1d and T1e landed — the
// authority check, the records engine and the task type — and only against a
// database migrated from empty.
//
// A fourth half is asserted here because the split's own contents line puts it
// in this part and nothing else would catch it: an audit event per attempt,
// including the refused ones.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import {
  COMMAND_SURFACE,
  NEEDS_NO_EXPECTED_REVISION,
} from '../../packages/core-records/src/commands/surface.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('command_shape: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('command_shape', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let spine: InstalledTaskSpine;

  const run = async (command: Parameters<typeof executeCommand>[4], who: Member = worker) =>
    await executeCommand(db.app, business, who.presented, 'api', command);

  const create = async (title: string, operationId: string = randomUUID()) =>
    await run({
      command: 'task.create',
      operationId,
      fields: { title },
    });

  const auditEvents = async () => await db.app.withBusiness(business, readAuditEvents);

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'command-shape');
    spine = await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'read');
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'manage');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('every mutating command requires an operation identity', () => {
    // `mutating` is the literal type `true` on the declaration, so nothing in
    // the surface can be a read and there is no runtime case to write for it:
    // a `false` is a type error. A case asserting it was removed after a
    // review pointed out that it could not fail.

    it('refuses a create with no identity at all', async () => {
      const refusal = await run({
        command: 'task.create',
        operationId: '',
        fields: { title: 'no identity' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('OPERATION_ID_REQUIRED');
    });

    it('refuses an identity too short to be an identity', async () => {
      const refusal = await run({
        command: 'task.create',
        operationId: 'abc',
        fields: { title: 'short' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('OPERATION_ID_REQUIRED');
    });

    it('writes an audit event for an attempt that never reached an identity', async () => {
      const before = await auditEvents();
      await run({
        command: 'task.create',
        operationId: '',
        fields: { title: 'still audited' },
      });
      const after = await auditEvents();
      expect(after.length).toBe(before.length + 1);
      const last = after.at(-1);
      expect(last?.operation_id).toBeNull();
      expect(last?.refusal_code).toBe('OPERATION_ID_REQUIRED');
    });
  });

  describe('every command that mutates an existing record requires a revision', () => {
    it('agrees with the declarations, so the list cannot drift from the table', () => {
      for (const command of COMMAND_SURFACE) {
        expect(command.targetsExistingRecord, command.name).toBe(
          !NEEDS_NO_EXPECTED_REVISION.has(command.name),
        );
      }
    });

    it('refuses an update that names no revision', async () => {
      const made = await create('needs a revision');
      expect(isCommandRefusal(made)).toBe(false);
      if (isCommandRefusal(made)) return;
      const refusal = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId ?? '',
        fields: { title: 'changed' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('EXPECTED_REVISION_REQUIRED');
    });

    it('refuses an update against a revision that has been overtaken', async () => {
      const made = await create('overtaken');
      if (isCommandRefusal(made)) throw new Error('create refused');
      const recordId = made.recordId ?? '';
      const first = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId,
        expectedRevision: made.revision ?? 0,
        fields: { title: 'first' },
      });
      expect(isCommandRefusal(first)).toBe(false);
      const stale = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId,
        expectedRevision: made.revision ?? 0,
        fields: { title: 'second' },
      });
      expect(isCommandRefusal(stale) && stale.code).toBe('VERSION_STALE');
      // With the current revision, so the caller can read and retry rather
      // than guess (T1-N1). Never a merge.
      expect(isCommandRefusal(stale) && stale.names).toStrictEqual(['revision=2']);
    });
  });

  describe('the same identity with the same payload replays', () => {
    it('returns the first result exactly, and writes no second record', async () => {
      const identity = `replay-${randomUUID()}`;
      const first = await create('replayed', identity);
      const again = await create('replayed', identity);
      expect(again).toStrictEqual(first);

      const rows = await db.app.withBusiness(business, async (tx) =>
        tx.query<{ readonly count: string }>(
          `select count(*)::text as count from records
            where business_id = $1 and record_type_id = $2 and data ->> 'title' = 'replayed'`,
          [business, spine.taskTypeId],
        ),
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('records the replay as an attempt of its own, so a retry storm is visible', async () => {
      const identity = `replay-audited-${randomUUID()}`;
      await create('replay audited', identity);
      const before = await auditEvents();
      await create('replay audited', identity);
      const after = await auditEvents();
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1)?.outcome).toBe('replayed');
      expect(after.at(-1)?.operation_id).toBe(identity);
    });

    it('replays a refusal too, because a refusal is a result', async () => {
      const identity = `replay-refusal-${randomUUID()}`;
      const shape = { command: 'task.create', operationId: identity } as const;
      const first = await run({ ...shape, fields: { title: 'x', source: 'agent' } });
      const again = await run({ ...shape, fields: { title: 'x', source: 'agent' } });
      expect(isCommandRefusal(first) && first.code).toBe('SOURCE_SPOOFED');
      expect(again).toStrictEqual(first);
    });
  });

  describe('an identity belongs to whoever presented it', () => {
    // The hole a cross-model review found. The register is read before
    // authority is checked, because a replay must not do the work twice; with
    // the identity keyed to the business rather than the actor, a member with
    // no grant at all who could name a colleague's `operation_id` was handed
    // the colleague's result.
    it('does not hand one caller another caller’s result', async () => {
      const identity = `mine-${randomUUID()}`;
      const mine = await create('my work', identity);
      if (isCommandRefusal(mine)) throw new Error('create refused');

      const outsider = await enrol(db.app, business, 'outsider');
      const theirs = await run(
        { command: 'task.create', operationId: identity, fields: { title: 'my work' } },
        outsider,
      );
      // The same identity and the same payload, and no grant: a refusal, not
      // a replay of somebody else's handle.
      expect(isCommandRefusal(theirs) && theirs.code).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(theirs)).not.toContain(mine.recordId);
    });

    it('lets two callers use the same identity for their own work', async () => {
      const identity = `shared-${randomUUID()}`;
      const other = await enrol(db.app, business, 'colleague');
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, other, 'write');
      });
      const mine = await create('same identity, my task', identity);
      const theirs = await run(
        {
          command: 'task.create',
          operationId: identity,
          fields: { title: 'same identity, their task' },
        },
        other,
      );
      // A natural identity — `pickup-T-431-attempt-2` — is only safe to
      // derive if two people deriving the same one do not collide.
      expect(isCommandRefusal(mine)).toBe(false);
      expect(isCommandRefusal(theirs) ? theirs.code : 'applied').toBe('applied');
      if (isCommandRefusal(mine) || isCommandRefusal(theirs)) return;
      expect(theirs.recordId).not.toBe(mine.recordId);
    });
  });

  describe('the same identity with a different payload is refused', () => {
    it('refuses rather than replaying the first answer to a second question', async () => {
      const identity = `reused-${randomUUID()}`;
      await create('the first payload', identity);
      const refusal = await create('a different payload', identity);
      expect(isCommandRefusal(refusal) && refusal.code).toBe('OPERATION_ID_REUSED');
    });

    it('refuses across commands as well as across payloads', async () => {
      const identity = `reused-command-${randomUUID()}`;
      const made = await create('one command', identity);
      if (isCommandRefusal(made)) throw new Error('create refused');
      const refusal = await run({
        command: 'task.update',
        operationId: identity,
        recordId: made.recordId ?? '',
        expectedRevision: made.revision ?? 0,
        fields: { title: 'another command' },
      });
      expect(isCommandRefusal(refusal) && refusal.code).toBe('OPERATION_ID_REUSED');
    });

    it('applies nothing when it refuses the reuse', async () => {
      const identity = `reused-nothing-${randomUUID()}`;
      await create('kept', identity);
      await create('discarded', identity);
      const rows = await db.app.withBusiness(business, async (tx) =>
        tx.query<{ readonly count: string }>(
          `select count(*)::text as count from records
            where business_id = $1 and data ->> 'title' = 'discarded'`,
          [business],
        ),
      );
      expect(rows[0]?.count).toBe('0');
    });
  });

  describe('an audit event per attempt, including the refusals', () => {
    it('writes exactly one event for an attempt that applied', async () => {
      const identity = `audited-applied-${randomUUID()}`;
      const before = await auditEvents();
      const made = await create('audited', identity);
      const after = await auditEvents();
      expect(after.length).toBe(before.length + 1);
      const event = after.at(-1);
      expect(event?.outcome).toBe('applied');
      expect(event?.command).toBe('task.create');
      expect(event?.actor_id).toBe(worker.actorId);
      expect(event?.subject_record_id).toBe(isCommandRefusal(made) ? null : made.recordId);
      expect(event?.refusal_code).toBeNull();
    });

    it('writes exactly one event for an attempt that was refused', async () => {
      const before = await auditEvents();
      await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: randomUUID(),
        expectedRevision: 1,
        fields: { title: 'nowhere' },
      });
      const after = await auditEvents();
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1)?.outcome).toBe('refused');
      expect(after.at(-1)?.refusal_code).toBe('NOT_FOUND');
    });

    it('carries the digest and never the payload', async () => {
      const secret = 'a-title-nobody-should-find-in-an-audit-row';
      await create(secret);
      const events = await auditEvents();
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(events.at(-1)?.payload_digest).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('sends an attempted provenance value to the event and not to the response', async () => {
      const spoofed = 'agent:pretending-to-be-a-person';
      const refusal = await run({
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'spoofed', source: spoofed },
      });
      expect(JSON.stringify(refusal)).not.toContain(spoofed);
      const events = await auditEvents();
      expect(events.at(-1)?.attempted).toStrictEqual({ source: spoofed });
    });

    it('leaves the register and the chain agreeing about what happened', async () => {
      const identity = `agree-${randomUUID()}`;
      await create('agreement', identity);
      const events = await auditEvents();
      const event = events.at(-1);
      const registered = await db.app.withBusiness(business, async (tx) =>
        tx.query<{ readonly payload_digest: string; readonly outcome: string }>(
          `select payload_digest, outcome from operations
            where business_id = $1 and operation_id = $2`,
          [business, identity],
        ),
      );
      // The two tables are written in one transaction and neither holds the
      // payload; the digest is what ties an attempt in the register to its
      // event in the chain.
      expect(registered[0]?.payload_digest).toBe(event?.payload_digest);
      expect(registered[0]?.outcome).toBe('applied');
      expect(event?.operation_id).toBe(identity);
    });
  });
});
