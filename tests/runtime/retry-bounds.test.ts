// SPDX-License-Identifier: AGPL-3.0-only
//
// The terminal side of the two bounded command retries.
//
// Both entries retry once on `isRetryableViolation` and then hand the fault to
// the caller: the person entry after one failed-audit event in a transaction of
// its own (`envelope.ts`, `executeCommand`, `recordFailure`), the agent entry
// with no audit event (`agent-envelope.ts`, `executeAgentCommand`).
// `cancel-rediscover.test.ts` and W02 (b) in `l6-schedules.test.ts` prove the
// successful retry; these cases prove the second loss is the last one.
//
// Each connection a command runs on is traced here: every transaction the
// entry opens on it, and every statement in each, so an attempt is counted by
// what it ran rather than inferred from the outcome. The trace is also where
// each schedule is forced, between one statement of the command and the next,
// so no timing is guessed at.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { AffectedSetChanged } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve,
  approveBody,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  createTask,
  freshPurpose,
  holdRows,
  propose,
  proposeBody,
  racer,
  reasonOf,
  revisionOf,
  rows,
  scalar,
  settle,
  appliedDetail,
  openSchedules,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/retry-bounds: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** One transaction the entry opened, and the statements it ran, in order. */
interface Traced {
  readonly statements: string[];
}

/** Called around each statement; a hook that awaits holds the transaction there. */
interface Hooks {
  readonly before?: (
    transaction: Traced,
    text: string,
    parameters: readonly unknown[],
  ) => Promise<void>;
  readonly after?: (transaction: Traced, text: string) => Promise<void>;
  readonly failed?: (transaction: Traced, text: string, cause: unknown) => Promise<void>;
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
          await hooks.before?.(transaction, text, parameters);
          try {
            const found = await target.query(text, parameters);
            transaction.statements.push(text);
            await hooks.after?.(transaction, text);
            return found;
          } catch (cause) {
            transaction.statements.push(text);
            await hooks.failed?.(transaction, text, cause);
            throw cause;
          }
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

/** `cancelAndClassify`'s held-reservation discovery: once unlocked, once under the locks. */
const CANCEL_DISCOVERY = /'lineage_cancelled' as cause/u;
const LOCKING = /\bfor (?:no key )?update\b/u;
const AUDIT_INSERT = /insert into audit_events/u;

/** The statements of a transaction that read grants: the authority it checked. */
const reads = (each: Traced): readonly string[] =>
  each.statements.filter((text) => /\bfrom public\.grants\b|\bgrants g\b/u.test(text));

describe.skipIf(serverUrl === undefined)('the bounded command retries, exhausted', () => {
  let s: Schedules;
  let manager: Member;

  beforeAll(async () => {
    s = await openSchedules('retry_bounds', 1_000_000);
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

  const registered = async (operationId: unknown): Promise<number> =>
    await count(
      `select count(*)::text as n from public.operations
        where business_id = $1 and operation_id = $2`,
      [operationId],
    );

  /** Backends in this database waiting on any lock. */
  async function awaitWaiting(want: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const waiting = await scalar(
        s,
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (waiting >= want) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error(`fewer than ${String(want)} backends ever waited: no schedule was established`);
  }

  it('person entry: task.cancel losing its discovery twice makes two attempts and answers the fault', async () => {
    const taskId = await createTask(s, 'a cancel whose lineage is revised under both discoveries');
    const purpose = freshPurpose();
    const first: Detail = await propose(s, taskId, { maximumMinor: 2_000, purpose });
    await approve(s, first);
    const lineageId = String(first['lineageId']);
    const cancel: Body = {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: taskId,
      lineageId,
      reason: 'the client withdrew the request',
    };

    // The schedule: each attempt reads its affected set unlocked, and before it
    // takes a lock a revision of the lineage is proposed and approved on
    // another connection and commits. The approval supersedes the hold the
    // attempt discovered and holds a new one, so the set it rechecks under its
    // locks names a reservation those locks do not cover. Exactly two
    // revisions are served; a third attempt would meet an unchanged set and
    // cancel, which is what makes a widened bound visible here.
    let revisions = 0;
    const cancelDb = traced(racer(s), {
      after: async (transaction, text) => {
        if (!CANCEL_DISCOVERY.test(text) || ran(transaction, CANCEL_DISCOVERY) !== 1) return;
        if (revisions >= 2) return;
        revisions += 1;
        const revised = appliedDetail(
          await asPerson(
            s,
            proposeBody(taskId, await revisionOf(s, taskId), {
              lineageId,
              maximumMinor: 2_000,
              purpose,
            }),
          ),
          'task.propose',
        );
        appliedDetail(await asPerson(s, approveBody(revised)), 'task.decide');
      },
    });

    let fault: unknown;
    try {
      await asPerson(s, cancel, cancelDb.database);
    } catch (cause) {
      fault = cause;
    } finally {
      await cancelDb.database.close();
    }

    // The terminal fault is the caller's, and it is the typed rollback.
    expect(fault).toBeInstanceOf(AffectedSetChanged);
    expect((fault as Error).message).toMatch(/cancellation: the affected set changed/u);
    expect(revisions).toBe(2);

    // Exactly two command attempts, each of which discovered, locked, rechecked
    // and rolled back before its first write; then the failed-audit
    // transaction, which ran no part of the command. Nothing else was opened.
    const attempts = cancelDb.transactions.filter((each) => ran(each, CANCEL_DISCOVERY) > 0);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(ran(attempt, CANCEL_DISCOVERY)).toBe(2);
      expect(ran(attempt, LOCKING)).toBeGreaterThan(0);
      expect(ran(attempt, /update public\.proposal_lineages/u)).toBe(0);
      expect(ran(attempt, AUDIT_INSERT)).toBe(0);
    }
    expect(cancelDb.transactions).toHaveLength(3);
    const audit = cancelDb.transactions[2]!;
    expect(ran(audit, CANCEL_DISCOVERY)).toBe(0);
    expect(ran(audit, AUDIT_INSERT)).toBe(1);
    // Both attempts ran the same authority reads, in the same order, as the
    // audit transaction's session resolution: one entry, one identity.
    expect(reads(attempts[0]!).length).toBeGreaterThan(0);
    expect(reads(attempts[1]!)).toStrictEqual(reads(attempts[0]!));

    // Nothing of the cancel committed: the lineage is live, no hold carries its
    // cause, its operation is not registered, and the only event under its
    // identity is the one failure, attributed to the person who presented it.
    expect(
      await count(
        `select count(*)::text as n from public.proposal_lineages
          where business_id = $1 and id = $2 and state = 'live' and terminal_at is null`,
        [lineageId],
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from public.reservations
          where business_id = $1 and classified_cause = 'lineage_cancelled'`,
        [],
      ),
    ).toBe(0);
    expect(await registered(cancel['operationId'])).toBe(0);
    expect(await outcomesOf(cancel['operationId'])).toStrictEqual(['failed']);
    expect(
      await count(
        `select count(*)::text as n from public.audit_events
          where business_id = $1 and operation_id = $2 and actor_id = $3`,
        [cancel['operationId'], s.decider.actorId],
      ),
    ).toBe(1);

    // Undisturbed, the same body cancels: the fault was the schedule's.
    expect(codeOf(await asPerson(s, cancel))).toBe('applied');
  }, 60_000);

  it('agent entry: a pickup losing operations_identity_key twice makes two attempts and answers the fault', async () => {
    const taskId = await createTask(s, 'a pickup that loses its identity claim on both attempts');
    const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
    const reservationId = String((await approve(s, proposal))['reservationId']);
    const body: Body = {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
      leaseSeconds: 600,
    };

    // Staged, not scheduled. No product schedule loses this claim twice: the
    // retry's register read (`lookupAttempt`) is keyed exactly as the
    // constraint is and the register has no update or delete path, so once
    // one winner has committed the retry replays it. To reach the terminal
    // branch, the owner connection commits a register row under the attempt's
    // own identity just before its insert, the insert meets the real
    // constraint, and the row is removed once it has lost. Two are staged.
    let staged = 0;
    let lost = 0;
    let stagedId: string | undefined;
    const agentDb = traced(racer(s), {
      before: async (_transaction, text, parameters) => {
        if (!/^\s*insert into operations\b/u.test(text) || staged >= 2) return;
        staged += 1;
        stagedId = randomUUID();
        await s.db.admin.execute(
          `insert into public.operations
             (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result)
           values ($1, $2, $3, 'task.pickup', $4, repeat('0', 64), 'refused', '{"code":"STAGED"}')`,
          [s.business, stagedId, parameters[2], parameters[4]] as never,
        );
      },
      failed: async (_transaction, text, cause) => {
        if (!/^\s*insert into operations\b/u.test(text)) return;
        if (
          (cause as { constraint_name?: unknown }).constraint_name !== 'operations_identity_key'
        ) {
          return;
        }
        lost += 1;
        // The register is append-only by trigger (`operations_append_only`),
        // which is the reason a second collision cannot happen on its own. The
        // owner lifts it for this one staged row of this throwaway database.
        if (!/^[0-9a-f-]{36}$/u.test(stagedId ?? '')) throw new Error('no staged row to remove');
        await s.db.admin.execute(
          `do $$ begin
             set local session_replication_role = replica;
             delete from public.operations where id = '${stagedId!}';
           end $$`,
          [] as never,
        );
      },
    });

    let fault: unknown;
    try {
      await asAgent(s, body, undefined, agentDb.database);
    } catch (cause) {
      fault = cause;
    } finally {
      await agentDb.database.close();
    }

    // The second collision is the caller's, as it was raised.
    expect(fault).toMatchObject({ code: '23505', constraint_name: 'operations_identity_key' });
    expect(staged).toBe(2);
    expect(lost).toBe(2);
    // Two transactions, each a whole pickup that reached the register and lost.
    expect(agentDb.transactions).toHaveLength(2);
    for (const attempt of agentDb.transactions) {
      expect(ran(attempt, /^\s*insert into operations\b/u)).toBe(1);
    }

    // Nothing committed: no lease, no delegation, the hold still held, no
    // register row, and no audit event of any outcome (none is written by
    // this entry for a raised fault, and none is required).
    expect(
      await count(
        `select count(*)::text as n from public.leases where business_id = $1 and task_id = $2`,
        [taskId],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::text as n from public.reservations
          where business_id = $1 and id = $2 and state = 'held'`,
        [reservationId],
      ),
    ).toBe(1);
    expect(await registered(body['operationId'])).toBe(0);
    expect(await outcomesOf(body['operationId'])).toStrictEqual([]);

    // Unstaged, the same body picks up.
    expect(codeOf(await asAgent(s, body))).toBe('applied');
  }, 60_000);

  it('grant.revoke takes its grant row before any runtime lock, and a parked pickup serialises behind neither', async () => {
    const taskId = await createTask(s, 'a revocation traced statement by statement');
    const proposal: Detail = await propose(s, taskId, {
      maximumMinor: 2_000,
      purpose: freshPurpose(),
    });
    const reservationId = String((await approve(s, proposal))['reservationId']);
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

    const pickupDb = racer(s);
    const revokeDb = traced(racer(s));
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    let settled: readonly PromiseSettledResult<CommandResult>[] = [];
    let waiting: readonly { relation: string; mode: string; query: string }[] = [];
    try {
      const picked = asAgent(
        s,
        { command: 'task.pickup', operationId: randomUUID(), reservationId, leaseSeconds: 600 },
        undefined,
        pickupDb,
      );
      await awaitParked(s, 'budget_caps', 1);
      const revoked = executeCommand(
        revokeDb.database,
        s.business,
        manager.presented,
        'api',
        revoke as never,
      );
      await Promise.race([awaitWaiting(2), revoked.catch(() => null)]);
      // Observed while the pickup is still parked on the cap row: every lock
      // any backend in this database is waiting for.
      waiting = await rows<{ relation: string; mode: string; query: string }>(
        s,
        `select coalesce(c.relname, l.locktype) as relation, l.mode,
                regexp_replace(left(a.query, 160), '\\s+', ' ', 'g') as query
           from pg_locks l
           join pg_stat_activity a on a.pid = l.pid
           left join pg_class c on c.oid = l.relation
          where not l.granted and a.datname = current_database()
          order by 1, 2, 3`,
        [],
      );
      await holder.release();
      settled = await settle([picked, revoked]);
    } finally {
      await holder.release().catch(() => null);
      await pickupDb.close();
      await revokeDb.database.close();
    }

    const [picked, revoked] = settled;
    expect(revoked?.status, reasonOf(revoked!)).toBe('fulfilled');
    expect(codeOf((revoked as PromiseFulfilledResult<CommandResult>).value)).toBe('applied');
    expect(picked?.status, reasonOf(picked!)).toBe('fulfilled');

    // One transaction, whose first locking statement is the grant row.
    expect(revokeDb.transactions).toHaveLength(1);
    const locking = revokeDb.transactions[0]!.statements.filter((text) => LOCKING.test(text));
    expect(locking[0]).toMatch(
      /from public\.grants where business_id = \$1 and id = \$2 for update/u,
    );
    // Observed, not assumed: what the pickup and the revocation were each
    // waiting for while the pickup was parked on the cap row.
    expect(waiting.length).toBeGreaterThan(0);
    console.info(
      `runtime/retry-bounds: grant.revoke locking order = ${JSON.stringify(
        locking.map((text) => /from (public\.\w+)/u.exec(text)?.[1] ?? text.slice(0, 60)),
      )}; waiting while parked = ${JSON.stringify(waiting)}; pickup = ${
        picked?.status === 'fulfilled' ? codeOf(picked.value) : reasonOf(picked!)
      }`,
    );
  }, 60_000);
});
