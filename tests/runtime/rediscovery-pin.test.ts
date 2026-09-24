// SPDX-License-Identifier: AGPL-3.0-only
//
// The statement sequence of each discover, lock and recheck site, pinned
// before those sites moved onto one rediscovery module (ARCH candidate 4). The
// move is behaviour-preserving only if each site still runs the same
// statements in the same order between its first unlocked discovery and its
// first write: the discovery, the ordered locks, the rediscovery under them.
//
// Nothing races here. Each command runs undisturbed through its real entry,
// on a traced connection, over work that gives the discovery something to
// find: a propose that supersedes a picked-up hold, a cancellation of a
// picked-up lineage, a delegation revocation and a grant revocation each with
// a live dependent lease, and the startup replay (over an empty eligible set).
//
// A statement is labelled by its first words and a digest of its whole text,
// and a row lock by its table, so a changed statement, a moved one and a
// missing one all fail here with the label that differs.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/recovery.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  liveWork,
  openSchedules,
  pickup,
  propose,
  proposeBody,
  racer,
  revisionOf,
  rows,
  type Body,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/rediscovery-pin: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** Every `withBusiness` transaction a connection opened, as the statements it ran. */
function traced(database: Database): {
  readonly database: Database;
  readonly transactions: readonly string[][];
} {
  const transactions: string[][] = [];
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> => {
        const statements: string[] = [];
        transactions.push(statements);
        return await target.withBusiness(
          businessId,
          async (tx) =>
            await run(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown;
                  return async (text: string, parameters: readonly unknown[] = []) => {
                    statements.push(text);
                    return await inner.query(text, parameters);
                  };
                },
              }),
            ),
        );
      };
    },
  });
  return { database: wrapped, transactions };
}

const normal = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();
const ROW_LOCK = /^select 1 from public\.(\w+) where business_id = \$1 and id = \$2 for update$/u;

function label(text: string): string {
  const flat = normal(text);
  const lock = ROW_LOCK.exec(flat);
  if (lock !== null) return `lock ${lock[1]}`;
  if (flat.includes('pg_advisory_xact_lock')) return 'lock chain';
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, 8);
  return `${flat.slice(0, 48)} #${digest}`;
}

/**
 * The site's window: from its first unlocked discovery to the last statement
 * that repeats one run before its locks, which is the end of its recheck.
 */
function windowOf(transactions: readonly string[][], discovery: RegExp): readonly string[] {
  const transaction = transactions.find((each) => each.some((text) => discovery.test(text)));
  if (transaction === undefined) throw new Error(`no transaction ran ${String(discovery)}`);
  const tail = transaction.slice(transaction.findIndex((text) => discovery.test(text)));
  const locked = tail.findIndex((text) => label(text).startsWith('lock '));
  const unlocked = new Set(tail.slice(0, locked));
  const end = tail.findLastIndex((text, index) => index > locked && unlocked.has(text));
  return tail.slice(0, end + 1).map((text) => label(text));
}

/** The lineage's live version: `lockProposal`'s first unlocked read (R2-RUNTIME-25). */
const PROPOSE_DISCOVERY =
  /from public\.proposal_versions\s+where business_id = \$1 and lineage_id = \$2 and superseded_at is null/u;
/** `cancelAndClassify`'s held-set discovery. */
const CANCEL_DISCOVERY = /'lineage_cancelled' as cause/u;
/** `classifyAuthorityLoss`'s live-work discovery by delegation and person lease. */
const LOSS_DISCOVERY = /l\.delegation_id = any\(\$2::uuid\[\]\)/u;
/** `dependents`: `grant.revoke`'s unlocked read. */
const REVOKE_DISCOVERY = /with recursive revoked as/u;
/** `discoverEligible`: the replay's business-wide read. */
const REPLAY_DISCOVERY = /then 'authority_revoked'/u;

function pin(site: keyof typeof PINNED, found: readonly string[]): void {
  if (process.env['PIN_PRINT'] !== undefined) console.log(`PIN ${site} ${JSON.stringify(found)}`);
  expect(found).toStrictEqual(PINNED[site]);
}

describe.skipIf(serverUrl === undefined)('the discover, lock and recheck sites, pinned', () => {
  let s: Schedules;
  let manager: Member;

  beforeAll(async () => {
    s = await openSchedules('rediscovery_pin', 1_000_000);
    manager = await enrol(s.db.app, s.business, 'manager');
    await s.db.app.withBusiness(s.business, async (tx) => {
      // Every action, because `delegation.revoke` asks the manager's ceiling
      // for each action the delegation carries.
      for (const action of ['read', 'comment', 'write', 'assign', 'decide', 'manage'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, manager, action);
      }
    });
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function run(body: Body, as: 'person' | 'manager' = 'person') {
    const connection = traced(racer(s));
    try {
      const result =
        as === 'person'
          ? await asPerson(s, body, connection.database)
          : await executeCommand(
              connection.database,
              s.business,
              manager.presented,
              'api',
              body as never,
            );
      expect(codeOf(result)).toBe('applied');
    } finally {
      await connection.database.close();
    }
    return connection.transactions;
  }

  it('task.propose superseding a picked-up hold', async () => {
    const taskId = await createTask(s, 'a revision over a picked-up hold');
    const purpose = freshPurpose();
    const first = await propose(s, taskId, { maximumMinor: 2_000, purpose });
    await pickup(s, (await approve(s, first))['reservationId']);
    const body = proposeBody(taskId, await revisionOf(s, taskId), {
      lineageId: String(first['lineageId']),
      maximumMinor: 2_500,
      purpose,
    });
    pin('propose', windowOf(await run(body), PROPOSE_DISCOVERY));
  }, 60_000);

  it('task.cancel of a picked-up lineage', async () => {
    const work = await liveWork(s, 'a cancellation of picked-up work', 2_000);
    const body: Body = {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: work.taskId,
      lineageId: work.proposal['lineageId'],
      reason: 'the client withdrew the request',
    };
    pin('cancel', windowOf(await run(body), CANCEL_DISCOVERY));
  }, 60_000);

  it('delegation.revoke with a live lease', async () => {
    const work = await liveWork(s, 'a delegation revoked under live work', 2_000);
    const found = await rows<{ delegation_id: string }>(
      s,
      `select delegation_id from public.leases where business_id = $1 and id = $2`,
      [s.business, work.picked['leaseId']],
    );
    const body: Body = {
      command: 'delegation.revoke',
      operationId: randomUUID(),
      delegationId: found[0]?.delegation_id,
    };
    pin('delegationRevoke', windowOf(await run(body, 'manager'), LOSS_DISCOVERY));
  }, 60_000);

  it('the startup replay over an empty eligible set', async () => {
    const connection = traced(racer(s));
    try {
      await connection.database.withBusiness(s.business, async (tx) => {
        expect(await replayRecordedTransitions(tx)).toStrictEqual([]);
      });
    } finally {
      await connection.database.close();
    }
    pin('replay', windowOf(connection.transactions, REPLAY_DISCOVERY));
  }, 60_000);

  // Last: it revokes the decider's task write, which the cases above need.
  it('grant.revoke with a dependent lease', async () => {
    const work = await liveWork(s, 'a grant revoked under live work', 2_000);
    const grants = await rows<{ id: string }>(
      s,
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [s.business, s.decider.personId],
    );
    expect(grants).toHaveLength(1);
    expect(work.picked['leaseId']).toBeDefined();
    const body: Body = {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: grants[0]?.id,
    };
    pin('grantRevoke', windowOf(await run(body, 'manager'), REVOKE_DISCOVERY));
  }, 60_000);
});

/** One hold's complete set: cap, envelope, task, run, lineage, lease, delegation, reservation. */
const LOCKS = [
  'lock budget_caps',
  'lock task_envelopes',
  'lock records',
  'lock planned_runs',
  'lock proposal_lineages',
  'lock leases',
  'lock delegations',
  'lock reservations',
] as const;
const LIVE_BY_VERSION = 'select l.id as lease_id, l.run_id, l.delegation_ #460e3290';
const LIVE_BY_LINEAGE = 'select l.id as lease_id, l.run_id, l.delegation_ #f4725945';
// Final review R1 #3: cancel discovers the lineage's open runs and locks them
// before the lineage, rather than updating them after it.
const RUNS_BY_LINEAGE = 'select id from public.planned_runs where busines #04eb9ec9';
const LIVE_BY_DELEGATION = 'select l.id as lease_id, l.run_id, l.delegation_ #b0bfa2b3';
const HELD_BY_VERSION = 'select res.id as reservation_id, res.envelope_id #ddefafce';
const LIVE_VERSION = 'select id from public.proposal_versions where bu #820e3c4d';
const OPEN_ENVELOPE = 'select id, cap_id, currency, maximum_minor::text #eb3efe48';
const HELD_BY_LINEAGE = 'select res.id as reservation_id, res.envelope_id #5168d3b0';
const HELD_BY_DELEGATION = 'select res.id as reservation_id, res.envelope_id #2223e6d4';
const ELIGIBLE = 'select res.id as reservation_id, res.envelope_id #31b71195';
const DEPENDENTS = 'with recursive revoked as ( select g.id, g.subje #c53e3eae';

/**
 * Taken at 21c99a0, before the move, and unchanged by it. Two changes since,
 * both on purpose: thermo O3's fix rechecks propose's held set under the locks
 * as well as its live work, so its window ends with that read; and final
 * review round 2 (R2-RUNTIME-25) moved propose's reads of the live version and
 * the task's envelope into the same discovery, so its window starts with them
 * and they are read again under the locks.
 */
const PROPOSE_SET = [LIVE_VERSION, OPEN_ENVELOPE, LIVE_BY_VERSION, HELD_BY_VERSION] as const;
const PINNED = {
  propose: [...PROPOSE_SET, ...LOCKS, ...PROPOSE_SET],
  cancel: [
    HELD_BY_LINEAGE,
    LIVE_BY_LINEAGE,
    RUNS_BY_LINEAGE,
    ...LOCKS,
    HELD_BY_LINEAGE,
    LIVE_BY_LINEAGE,
    RUNS_BY_LINEAGE,
  ],
  delegationRevoke: [
    LIVE_BY_DELEGATION,
    HELD_BY_DELEGATION,
    ...LOCKS,
    LIVE_BY_DELEGATION,
    HELD_BY_DELEGATION,
  ],
  replay: [ELIGIBLE, ELIGIBLE],
  grantRevoke: [
    DEPENDENTS,
    LIVE_BY_DELEGATION,
    HELD_BY_DELEGATION,
    ...LOCKS,
    LIVE_BY_DELEGATION,
    HELD_BY_DELEGATION,
    DEPENDENTS,
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;
