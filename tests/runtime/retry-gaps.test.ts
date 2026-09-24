// SPDX-License-Identifier: AGPL-3.0-only
//
// The three other discovery-changed rollbacks: `task.propose`'s live-work
// recheck (`propose.ts`, `lockProposal`), `task.handback`'s lease-binding
// recheck (`handback.ts`) and `grant.revoke`'s dependent-attempt recheck
// (`authority-controls.ts`, `revokeGrantCommand`). Each rolls back before its
// first write rather than extend its lock set. They threw a plain `Error`,
// which neither command entry retries, so a request that lost the race was a
// 503 although the same body, sent again, applied. `cancel-rediscover.test.ts`
// fixed the same rollback for cancel; these are now `AffectedSetChanged` too,
// retried once in a fresh transaction.
//
// Each schedule is forced between one statement of the command and the next,
// as `retry-bounds.test.ts` does: another connection commits a real command
// in the window between the unlocked discovery and the locks, so no timing is
// guessed at.
//
// - propose: a pickup of the superseded version's hold commits in the window.
//   Reachable: nothing the proposal holds before its locks stops a pickup.
// - grant.revoke: a handback of a dependent lease commits in the window (the
//   shrink side). Reachable: handback reads grants without a row lock, so the
//   revocation's `for update` on its grant row does not hold it back. The
//   growth side is not (RETRY-BOUNDS: a pickup holds `for share` on its
//   covering grants). A shrink after the authority-loss classifier's own
//   discovery is met there first, and that throw was already typed.
// - handback: not reachable as a race. The binding it rechecks is the lease's
//   reservation, that reservation's version and the version's lineage beside
//   the run's lineage; no statement in this head updates any of those columns
//   and a version is immutable (0010, `proposal_versions_immutable`). The
//   thrown type is proved by rewriting that one read's result instead.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import { isRetryableViolation } from '../../packages/core-records/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { AffectedSetChanged } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  openSchedules,
  propose,
  proposeBody,
  racer,
  revisionOf,
  rows,
  scalar,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/retry-gaps: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** One transaction the entry opened, and the statements it ran, in order. */
interface Traced {
  readonly statements: string[];
}

interface Hooks {
  /** Runs after a statement returns; awaiting it holds the transaction there. */
  readonly after?: (transaction: Traced, text: string) => Promise<void>;
  /** Replaces a statement's rows before the command sees them. */
  readonly rewrite?: (text: string, found: readonly unknown[]) => readonly unknown[];
}

/** A connection whose every `withBusiness` transaction is traced. */
function traced(
  database: Database,
  hooks: Hooks = {},
): { readonly database: Database; readonly transactions: readonly Traced[] } {
  const transactions: Traced[] = [];
  const wrapTx = (tx: TenantQuery, transaction: Traced): TenantQuery =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
        return async (text: string, parameters: readonly unknown[] = []) => {
          const found = await target.query(text, parameters);
          transaction.statements.push(text);
          await hooks.after?.(transaction, text);
          return hooks.rewrite === undefined ? found : hooks.rewrite(text, found);
        };
      },
    });
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> => {
        const transaction: Traced = { statements: [] };
        transactions.push(transaction);
        return await target.withBusiness(
          businessId,
          async (tx) => await run(wrapTx(tx, transaction)),
        );
      };
    },
  });
  return { database: wrapped, transactions };
}

const ran = (transaction: Traced, pattern: RegExp): number =>
  transaction.statements.filter((text) => pattern.test(text)).length;

/** `discoverLiveWork` by version: `lockProposal`'s unlocked read, then its recheck. */
const PROPOSE_LIVE_WORK = /run\.version_id = any\(\$2::uuid\[\]\)/u;
/** `dependents`: `grant.revoke`'s unlocked read, then its recheck under the locks. */
const REVOKE_DEPENDENTS = /with recursive revoked as/u;
/** `handback`'s lease-binding read under the locks. */
const HANDBACK_BINDING = /as lease_reservation/u;
const LOCKING = /\bfor (?:no key )?update\b/u;
const AUDIT_INSERT = /insert into audit_events/u;

const pickupBody = (reservationId: string): Body => ({
  command: 'task.pickup',
  operationId: randomUUID(),
  reservationId,
  leaseSeconds: 600,
});

describe('the three rechecks raise the retryable type', () => {
  it('a plain Error with the same message is still not retried', () => {
    for (const message of [
      'propose: the live work on the superseded version changed under discovery; roll back and rediscover',
      'handback: the lease binding changed under discovery; roll back and rediscover rather than extending the lock set',
      'grant.revoke: the dependent attempts changed under discovery; roll back and rediscover rather than extending the lock set',
    ]) {
      expect(isRetryableViolation(new AffectedSetChanged(message))).toBe(true);
      expect(isRetryableViolation(new Error(message))).toBe(false);
    }
  });
});

describe.skipIf(serverUrl === undefined)(
  'propose, handback and grant.revoke losing discovery',
  () => {
    let s: Schedules;
    let manager: Member;

    beforeAll(async () => {
      s = await openSchedules('retry_gaps', 1_000_000);
      manager = await enrol(s.db.app, s.business, 'manager');
      await s.db.app.withBusiness(s.business, async (tx) => {
        for (const action of ['read', 'write', 'manage'] as const) {
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, manager, action);
        }
      });
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    const count = async (text: string, parameters: readonly unknown[]): Promise<number> =>
      await scalar(s, text, [s.business, ...parameters]);

    const outcomesOf = async (operationId: unknown): Promise<readonly string[]> =>
      (
        await rows<{ outcome: string }>(
          s,
          `select outcome from public.audit_events
          where business_id = $1 and operation_id = $2 order by outcome`,
          [s.business, operationId],
        )
      ).map((each) => each.outcome);

    /** An approved lineage whose live version has an unleased hold, and a revision of it. */
    async function heldLineage(title: string): Promise<{
      readonly taskId: string;
      readonly first: Detail;
      readonly reservationId: string;
      readonly revise: () => Promise<Body>;
    }> {
      const taskId = await createTask(s, title);
      const purpose = freshPurpose();
      const first: Detail = await propose(s, taskId, { maximumMinor: 2_000, purpose });
      const reservationId = String((await approve(s, first))['reservationId']);
      const revise = async (): Promise<Body> =>
        proposeBody(taskId, await revisionOf(s, taskId), {
          lineageId: String(first['lineageId']),
          maximumMinor: 2_500,
          purpose,
        });
      return { taskId, first, reservationId, revise };
    }

    it('propose meeting a pickup of the superseded hold answers the first request after one retry', async () => {
      const { first, reservationId, revise } = await heldLineage(
        'a revision whose superseded hold is picked up under discovery',
      );
      const body = await revise();

      // The schedule: after the first attempt's unlocked live-work read, the
      // superseded version's hold is picked up on another connection and
      // commits. The attempt's recheck under its locks then names a lease those
      // locks do not cover.
      let picked: Detail | undefined;
      const proposeDb = traced(racer(s), {
        after: async (transaction, text) => {
          if (!PROPOSE_LIVE_WORK.test(text) || ran(transaction, PROPOSE_LIVE_WORK) !== 1) return;
          if (picked !== undefined) return;
          picked = appliedDetail(await asAgent(s, pickupBody(reservationId)), 'task.pickup');
        },
      });
      let result: CommandResult;
      try {
        result = await asPerson(s, body, proposeDb.database);
      } finally {
        await proposeDb.database.close();
      }

      expect(picked).toBeDefined();
      expect(codeOf(result)).toBe('applied');
      const attempts = proposeDb.transactions.filter((each) => ran(each, PROPOSE_LIVE_WORK) > 0);
      expect(attempts).toHaveLength(2);
      // The lost attempt discovered, locked and rechecked, and wrote nothing.
      expect(ran(attempts[0]!, PROPOSE_LIVE_WORK)).toBe(2);
      expect(ran(attempts[0]!, LOCKING)).toBeGreaterThan(0);
      expect(ran(attempts[0]!, /insert into public\.proposal_versions/u)).toBe(0);
      expect(ran(attempts[0]!, AUDIT_INSERT)).toBe(0);
      // The retry locked the lease it now saw and retired it with the version.
      expect(
        await count(
          `select count(*)::text as n from public.leases where business_id = $1 and id = $2
            and state = 'live'`,
          [picked!['leaseId']],
        ),
      ).toBe(0);
      expect(
        await count(
          `select count(*)::text as n from public.proposal_versions
          where business_id = $1 and lineage_id = $2`,
          [first['lineageId']],
        ),
      ).toBe(2);
      expect(await outcomesOf(body['operationId'])).toStrictEqual(['applied']);
    }, 60_000);

    it('propose losing its discovery twice makes two attempts, answers the fault and commits nothing', async () => {
      const { first, reservationId, revise } = await heldLineage(
        'a revision whose live work changes under both discoveries',
      );
      const body = await revise();

      // Two changes, one per attempt: the hold is picked up under the first
      // discovery, and that lease is handed back under the second.
      let served = 0;
      let picked: Detail | undefined;
      const proposeDb = traced(racer(s), {
        after: async (transaction, text) => {
          if (!PROPOSE_LIVE_WORK.test(text) || ran(transaction, PROPOSE_LIVE_WORK) !== 1) return;
          if (served === 0) {
            picked = appliedDetail(await asAgent(s, pickupBody(reservationId)), 'task.pickup');
          } else if (served === 1) {
            appliedDetail(
              await asAgent(s, handbackBody(picked!), String(picked!['credential'])),
              'task.handback',
            );
          } else {
            return;
          }
          served += 1;
        },
      });
      let fault: unknown;
      try {
        await asPerson(s, body, proposeDb.database);
      } catch (cause) {
        fault = cause;
      } finally {
        await proposeDb.database.close();
      }

      expect(fault).toBeInstanceOf(AffectedSetChanged);
      expect((fault as Error).message).toMatch(/propose: the live work on the superseded version/u);
      expect(served).toBe(2);
      const attempts = proposeDb.transactions.filter((each) => ran(each, PROPOSE_LIVE_WORK) > 0);
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(ran(attempt, PROPOSE_LIVE_WORK)).toBe(2);
        expect(ran(attempt, /insert into public\.proposal_versions/u)).toBe(0);
        expect(ran(attempt, AUDIT_INSERT)).toBe(0);
      }
      // Nothing of the revision committed; its only event is the one failure.
      expect(
        await count(
          `select count(*)::text as n from public.proposal_versions
          where business_id = $1 and lineage_id = $2`,
          [first['lineageId']],
        ),
      ).toBe(1);
      expect(await outcomesOf(body['operationId'])).toStrictEqual(['failed']);
    }, 60_000);

    it('handback: a changed binding is the retryable type, retried once by the agent entry', async () => {
      const work = await liveWork(s, 'a handback whose binding read is rewritten', 2_000);
      const body = handbackBody(work.picked);

      // Not a reachable schedule (header): the binding read's result is
      // rewritten on every attempt, which proves the type and the bound only.
      const handbackDb = traced(racer(s), {
        rewrite: (text, found) =>
          HANDBACK_BINDING.test(text)
            ? found.map((row) => ({ ...(row as object), lineage_id: randomUUID() }))
            : found,
      });
      let fault: unknown;
      try {
        await asAgent(s, body, String(work.picked['credential']), handbackDb.database);
      } catch (cause) {
        fault = cause;
      } finally {
        await handbackDb.database.close();
      }

      expect(fault).toBeInstanceOf(AffectedSetChanged);
      expect((fault as Error).message).toMatch(/handback: the lease binding changed/u);
      const attempts = handbackDb.transactions.filter((each) => ran(each, HANDBACK_BINDING) > 0);
      expect(attempts).toHaveLength(2);
      // Nothing settled and nothing retained: the throw is before any write.
      expect(
        await count(
          `select count(*)::text as n from public.leases where business_id = $1 and id = $2
            and state = 'live'`,
          [work.picked['leaseId']],
        ),
      ).toBe(1);
      expect(
        await count(
          `select count(*)::text as n from public.handback_reports
          where business_id = $1 and lease_id = $2`,
          [work.picked['leaseId']],
        ),
      ).toBe(0);
      // Undisturbed, the same body settles.
      expect(codeOf(await asAgent(s, body, String(work.picked['credential'])))).toBe('applied');
    }, 60_000);

    // Last: it revokes the decider's task write, which the cases above need.
    it('grant.revoke meeting a handback of a dependent lease answers the first request after one retry', async () => {
      const work = await liveWork(s, 'a dependent lease handed back under the revocation', 2_000);
      const grants = await rows<{ id: string }>(
        s,
        `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
        [s.business, s.decider.personId],
      );
      expect(grants).toHaveLength(1);
      const revoke: Body = {
        command: 'grant.revoke',
        operationId: randomUUID(),
        grantId: grants[0]?.id,
      };

      // The schedule: after the first attempt's unlocked dependents read, the
      // dependent lease is handed back on another connection and commits. The
      // classifier's own discovery runs after that, so its recheck agrees; the
      // revocation's recheck of its dependents does not.
      let handedBack = false;
      const revokeDb = traced(racer(s), {
        after: async (transaction, text) => {
          if (!REVOKE_DEPENDENTS.test(text) || ran(transaction, REVOKE_DEPENDENTS) !== 1) return;
          if (handedBack) return;
          handedBack = true;
          appliedDetail(
            await asAgent(s, handbackBody(work.picked), String(work.picked['credential'])),
            'task.handback',
          );
        },
      });
      let result: CommandResult;
      try {
        result = await executeCommand(
          revokeDb.database,
          s.business,
          manager.presented,
          'api',
          revoke as never,
        );
      } finally {
        await revokeDb.database.close();
      }

      expect(handedBack).toBe(true);
      expect(codeOf(result)).toBe('applied');
      const attempts = revokeDb.transactions.filter((each) => ran(each, REVOKE_DEPENDENTS) > 0);
      expect(attempts).toHaveLength(2);
      expect(ran(attempts[0]!, REVOKE_DEPENDENTS)).toBe(2);
      expect(ran(attempts[0]!, /update public\.grants/u)).toBe(0);
      expect(ran(attempts[0]!, AUDIT_INSERT)).toBe(0);
      expect(
        await count(
          `select count(*)::text as n from public.grants
          where business_id = $1 and id = $2 and revoked_at is not null`,
          [revoke['grantId']],
        ),
      ).toBe(1);
      expect(await outcomesOf(revoke['operationId'])).toStrictEqual(['applied']);
    }, 60_000);
  },
);
