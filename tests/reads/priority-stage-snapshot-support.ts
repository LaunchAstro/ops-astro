// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import {
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { appliedTask, type RankCoreWorld } from './task-rank-core-world.ts';
import { priorityApplied } from '../commands/priority-stages-support.ts';

export interface Backend {
  readonly pid: number;
  readonly isolation: string;
}

export interface ReplyBarrier {
  readonly database: Database;
  readonly arrived: Promise<Backend>;
  readonly heldCount: () => number;
  release(): void;
}

function signal<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error('Snapshot signal was not initialised');
  return { promise, resolve };
}

export async function bounded<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error(`Snapshot fixture deadline: ${label}`)), 8_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function backend(tx: TransactionQuery): Promise<Backend> {
  const rows = await tx.query<Backend>(
    `select pg_backend_pid() as pid, current_setting('transaction_isolation') as isolation`,
  );
  const one = rows[0];
  if (
    one === undefined ||
    !Number.isSafeInteger(one.pid) ||
    one.pid <= 0 ||
    one.isolation !== 'read committed'
  )
    throw new Error('Snapshot fixture requires actual default READ COMMITTED');
  // Fixture-only finite server waits; transaction isolation is never changed.
  await tx.query(`select set_config('statement_timeout', '8000', true)`);
  await tx.query(`select set_config('lock_timeout', '4000', true)`);
  return one;
}

function rankReply(row: unknown, target: string): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    row.id === target &&
    'impact' in row &&
    typeof row.impact === 'string' &&
    'confidence' in row &&
    typeof row.confidence === 'string' &&
    'ease' in row &&
    typeof row.ease === 'string' &&
    'stage' in row &&
    row.stage === 'trust' &&
    'open' in row &&
    row.open === true &&
    'started_at' in row &&
    row.started_at === null &&
    'now' in row &&
    row.now instanceof Date
  );
}

// Holds one REAL database reply, not a fabricated result or SQL-text proxy.
// Its semantic row shape is shared by both old353 and joined db470 pools.
export function holdRankReply(app: Database, target: string): ReplyBarrier {
  const arrived = signal<Backend>();
  const release = signal<void>();
  let held = 0;
  const database: Database = {
    log: app.log,
    close: () => app.close(),
    async withBusiness<T>(business: string, run: (tx: TransactionQuery) => Promise<T>): Promise<T> {
      return await app.withBusiness(business, async (tx) => {
        const observed = await backend(tx);
        const wrapped: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: (work) => tx.savepoint(work),
          async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
            const rows = await tx.query<Row>(text, parameters);
            if (rows.some((row) => rankReply(row, target))) {
              held += 1;
              if (held !== 1) throw new Error('Snapshot fixture matched more than one pool reply');
              arrived.resolve(observed);
              await bounded('release held rank reply', release.promise);
            }
            return rows;
          },
        };
        return await run(wrapped);
      });
    },
  };
  return {
    database,
    arrived: arrived.promise,
    heldCount: () => held,
    release: () => release.resolve(),
  };
}

// All commands still resolve session, grants, revision, register and audit in
// the canonical envelope. The fixture merely makes their normal transaction
// callbacks share one real tenant-fenced transaction for the atomic change.
function inTransaction(app: Database, tx: TransactionQuery): Database {
  return {
    log: app.log,
    close(): Promise<void> {
      return Promise.reject(
        new Error('The fixture owns the real app connection, not this transaction adapter'),
      );
    },
    async withBusiness<T>(business: string, run: (tx: TransactionQuery) => Promise<T>): Promise<T> {
      if (business !== tx.businessId) throw new Error('Snapshot fixture crossed its tenant');
      return await run(tx);
    },
  };
}

export function snapshotWriter(world: RankCoreWorld): Database {
  // The existing app pool defaults to max=1. This is a second owned app
  // connection with the SAME restricted app role and tenant wrapper.
  return connect(world.db.appUrl, { source: 'snapshot-writer' });
}

export async function commitSnapshotChange(
  world: RankCoreWorld,
  app: Database,
  target: { readonly id: string; readonly revision: number },
  settingRevision: number,
): Promise<{ readonly backend: Backend; readonly taskRevision: number }> {
  return await app.withBusiness(world.business, async (tx) => {
    const observed = await backend(tx);
    const database = inTransaction(app, tx);
    const command = async (request: UncheckedRequest) =>
      await executeCommand(database, world.business, world.owner.presented, 'api', {
        operationId: randomUUID(),
        ...request,
      });
    const stage = appliedTask(
      await command({
        command: 'task.set_stage',
        recordId: target.id,
        expectedRevision: target.revision,
        fields: { stage: 'sales' },
      }),
    );
    const scores = appliedTask(
      await command({
        command: 'task.set_scores',
        recordId: target.id,
        expectedRevision: stage.revision,
        fields: { impact: 10, confidence: 9, ease: 10 },
      }),
    );
    priorityApplied(
      await command({
        command: 'settings.set_priority_stages',
        value: ['trust'],
        expectedRevision: settingRevision,
      }),
    );
    return { backend: observed, taskRevision: scores.revision };
  });
}
