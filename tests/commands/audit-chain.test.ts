// SPDX-License-Identifier: AGPL-3.0-only
//
// The audit chain: one append-only chain per business, its position and its
// hash written by the server, and a verifier that can tell when it has been
// tampered with (ADR 0039).
//
// The cases that matter are the negative ones. A hash chain nobody can break
// on purpose is a hash chain nobody has shown to notice anything, so two cases
// here disable the append-only trigger — which needs the table owner, not the
// application role — and then break the chain in the two ways it can break: a
// changed row, and a removed one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  readAuditEvents,
  verifyAuditChain,
  writeAuditEvent,
} from '../../packages/core-records/src/commands/audit.ts';
import { payloadDigest } from '../../packages/core-records/src/commands/digest.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('audit chain: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('the audit chain', () => {
  let db: FreshDatabase;
  let business: string;
  let other: string;
  let actor: string;
  let otherActor: string;

  const enrol = async (which: string): Promise<string> =>
    await db.app.withBusiness(which, async (tx) => {
      const person = await insertPerson(tx, 'auditor');
      return await insertActor(tx, person);
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'audit-a');
    other = await insertBusiness(db.app, 'audit-b');
    actor = await enrol(business);
    otherActor = await enrol(other);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const write = async (
    which: string,
    who: string,
    event: Partial<Parameters<typeof writeAuditEvent>[1]> = {},
  ): Promise<{ readonly seq: string; readonly hash: string }> =>
    await db.app
      .withBusiness(which, async (tx) =>
        writeAuditEvent(tx, {
          actorId: who,
          command: 'task.create',
          operationId: randomUUID(),
          outcome: 'applied',
          payloadDigest: payloadDigest({ title: 'one' }),
          ...event,
        }),
      )
      .then((written) => {
        hashesBySeq.set(written.seq, written.hash);
        return written;
      });

  // The hash of the event before the one at `seq`, so a case that rewrites a
  // link can put the real one back.
  let hashesBySeq: Map<string, string> = new Map();
  const previousHashOf = (seq: string): string | null => {
    const before = String(BigInt(seq) - 1n);
    return hashesBySeq.get(before) ?? null;
  };

  it('starts a business at one, with nothing before it', async () => {
    const first = await write(business, actor);
    expect(first.seq).toBe('1');
    const [event] = await db.app.withBusiness(business, readAuditEvents);
    expect(event?.prev_hash).toBeNull();
    expect(event?.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('links each event to the one before it', async () => {
    const first = await write(business, actor);
    const second = await write(business, actor);
    expect(Number(second.seq)).toBe(Number(first.seq) + 1);
    const events = await db.app.withBusiness(business, readAuditEvents);
    const at = new Map(events.map((event) => [event.seq, event]));
    expect(at.get(second.seq)?.prev_hash).toBe(first.hash);
  });

  it('gives each business its own chain, so one tenant cannot move another', async () => {
    const mine = await write(business, actor);
    const theirs = await write(other, otherActor);
    expect(theirs.seq).toBe('1');
    expect(Number(mine.seq)).toBeGreaterThan(1);
  });

  it('writes the position and the hash itself, whatever a caller supplies', async () => {
    const forged = '0'.repeat(64);
    const written = await db.app.withBusiness(business, async (tx) =>
      writeAuditEvent(tx, {
        actorId: actor,
        command: 'task.update',
        operationId: randomUUID(),
        outcome: 'refused',
        refusalCode: 'VERSION_STALE',
        payloadDigest: payloadDigest({ title: 'two' }),
        // Offered, and ignored: the columns are the trigger's.
        seq: '99',
        prevHash: forged,
        hash: forged,
      }),
    );
    expect(written.seq).not.toBe('99');
    expect(written.hash).not.toBe(forged);
  });

  it('keeps an attempted value out of the response and in the event', async () => {
    await write(business, actor, {
      command: 'task.create',
      outcome: 'refused',
      refusalCode: 'SOURCE_SPOOFED',
      attempted: { source: 'agent:pretending-to-be-a-person' },
    });
    const events = await db.app.withBusiness(business, readAuditEvents);
    const spoof = events.find((event) => event.refusal_code === 'SOURCE_SPOOFED');
    expect(spoof?.attempted).toStrictEqual({ source: 'agent:pretending-to-be-a-person' });
  });

  // A case here wrote `WRONG_BUSINESS` and read it back. No constraint limits
  // `refusal_code`, so it proved that Postgres stores text, and a review
  // caught it. The rule it was reaching for — an audit-only code is recorded
  // and never returned — is a property of `asCallerVisible` and is tested in
  // `refusal-register.test.ts`, where it can fail.

  it('holds no update or delete privilege for the application role', async () => {
    await expect(
      db.app.withBusiness(business, async (tx) =>
        tx.query('update audit_events set command = $1 where business_id = $2', [
          'task.forged',
          business,
        ]),
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      db.app.withBusiness(business, async (tx) =>
        tx.query('delete from audit_events where business_id = $1', [business]),
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('refuses an update even from the owner, because append-only is the table’s', async () => {
    await db.admin.execute(`select set_config('app.business_id', $1, false)`, [business]);
    await expect(
      db.admin.execute('update audit_events set command = $1 where business_id = $2', [
        'task.forged',
        business,
      ]),
    ).rejects.toThrow(/APPEND_ONLY/u);
  });

  describe('the verifier', () => {
    it('says a chain nobody has touched is intact', async () => {
      const events = await db.app.withBusiness(business, readAuditEvents);
      const report = await db.app.withBusiness(business, verifyAuditChain);
      expect(report.intact).toBe(true);
      expect(report.firstBreak).toBeUndefined();
      // Against the rows rather than against itself. An earlier version of
      // this case compared `report.length` with `report.length`, which a
      // review caught.
      expect(report.length).toBe(events.length);
      expect(report.length).toBeGreaterThan(4);
    });

    it('catches a row changed by someone who could disable the trigger', async () => {
      const target = await write(business, actor, { command: 'task.complete' });
      await db.admin.execute('alter table public.audit_events disable trigger audit_append_only');
      try {
        await db.admin.execute(
          'update public.audit_events set command = $1 where business_id = $2 and seq = $3',
          ['task.reopen', business, target.seq],
        );
        const report = await db.app.withBusiness(business, verifyAuditChain);
        expect(report.intact).toBe(false);
        expect(report.firstBreak).toStrictEqual({ seq: target.seq, reason: 'hash' });
      } finally {
        await db.admin.execute(
          'update public.audit_events set command = $1 where business_id = $2 and seq = $3',
          ['task.complete', business, target.seq],
        );
        await db.admin.execute('alter table public.audit_events enable trigger audit_append_only');
      }
    });

    it('catches a link rewritten by someone who recomputed the hash to match', async () => {
      // The forgery a per-row hash check on its own would accept: change what
      // a row says came before it, then recompute its own hash from the new
      // value with the server's own function, so the row is internally
      // consistent. Only the link to the row before it disagrees.
      const target = await write(business, actor, { command: 'task.assign' });
      await db.admin.execute('alter table public.audit_events disable trigger audit_append_only');
      try {
        await db.admin.execute(
          `update public.audit_events a
              set prev_hash = repeat('a', 64),
                  hash = public.audit_event_hash(repeat('a', 64), a.business_id, a.seq,
                    a.occurred_at, a.actor_id, a.command, a.operation_id, a.outcome,
                    a.refusal_code, a.subject_record_id, a.payload_digest, a.attempted)
            where a.business_id = $1 and a.seq = $2`,
          [business, target.seq],
        );
        const report = await db.app.withBusiness(business, verifyAuditChain);
        expect(report.intact).toBe(false);
        // Not `hash`: the row hashes to exactly what it stores. The break is
        // the chain, which is the whole reason there is a chain.
        expect(report.firstBreak).toStrictEqual({ seq: target.seq, reason: 'link' });
      } finally {
        await db.admin.execute(
          `update public.audit_events a
              set prev_hash = $3,
                  hash = public.audit_event_hash($3, a.business_id, a.seq, a.occurred_at,
                    a.actor_id, a.command, a.operation_id, a.outcome, a.refusal_code,
                    a.subject_record_id, a.payload_digest, a.attempted)
            where a.business_id = $1 and a.seq = $2`,
          [business, target.seq, previousHashOf(target.seq)],
        );
        await db.admin.execute('alter table public.audit_events enable trigger audit_append_only');
      }
    });

    it('catches a row removed, which a per-row hash alone would not', async () => {
      const target = await write(business, actor, { command: 'task.reopen' });
      // One more after it, so removing the target leaves a hole rather than
      // simply shortening the chain. A gap is the break a per-row hash cannot
      // see: every surviving row still hashes to its own stored hash.
      await write(business, actor, { command: 'task.complete' });
      const kept = await db.app.withBusiness(business, async (tx) =>
        tx.query<Record<string, unknown>>(
          'select * from audit_events where business_id = $1 and seq = $2',
          [business, target.seq],
        ),
      );
      await db.admin.execute('alter table public.audit_events disable trigger audit_append_only');
      try {
        await db.admin.execute(
          'delete from public.audit_events where business_id = $1 and seq = $2',
          [business, target.seq],
        );
        const report = await db.app.withBusiness(business, verifyAuditChain);
        expect(report.intact).toBe(false);
        expect(report.firstBreak?.reason).toBe('gap');
      } finally {
        expect(kept).toHaveLength(1);
        await db.admin.execute('alter table public.audit_events enable trigger audit_append_only');
      }
    });
  });
});
