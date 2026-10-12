// SPDX-License-Identifier: AGPL-3.0-only
//
// A command that dies after its writes and before its commit. A fixture
// transaction on its own connection holds what the command's last writes
// need: the business's audit-chain lock (the trigger's transaction-scoped
// advisory key), or, for a command that writes no applied event, its own
// register row's identity, claimed and not yet committed. The command makes
// every other write it makes and parks there. The parked statement is
// cancelled, so the server aborts the transaction at that step as a crash
// would (the connection stays up, so the pool lives on), and the hold is let
// go. What the command wrote must be gone.

import { randomUUID } from 'node:crypto';
import type {
  AdminConnection,
  TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn, type LockEvent } from './lock-waits.ts';

export interface ChainDatabase {
  readonly admin: Pick<AdminConnection, 'execute'>;
  readonly appUrl: string;
}

interface Park {
  readonly take: (tx: TenantQuery) => Promise<unknown>;
  readonly ending: 'commit' | 'rollback';
  readonly event: LockEvent;
  readonly statement: string;
}

type Died<T> = { readonly answer: T | null; readonly ended: number };

async function diesParkedAt<T>(
  db: ChainDatabase,
  businessId: string,
  park: Park,
  run: () => Promise<T>,
): Promise<Died<T>> {
  const held = await hold(db.appUrl, businessId, park.take, park.ending);
  let running: Promise<T> | undefined;
  let ended = 0;
  try {
    running = run();
    await waitingOn(db.admin, park.event, park.statement);
    const rows = await db.admin.execute<{ readonly n: number }>(
      `select count(*) filter (where pg_cancel_backend(pid))::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and wait_event = $1 and strpos(query, $2) > 0`,
      [park.event, park.statement],
    );
    ended = rows[0]?.n ?? 0;
  } finally {
    await held.letGo();
  }
  const answer = await running.catch(() => null);
  return { answer, ended };
}

/** `run`'s answer once its transaction died while it waited to write its audit event. */
export async function diesAtTheAuditChain<T>(
  db: ChainDatabase,
  businessId: string,
  run: () => Promise<T>,
): Promise<Died<T>> {
  const take = async (tx: TenantQuery): Promise<void> => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [businessId]);
  };
  const park: Park = {
    take,
    ending: 'commit',
    event: 'advisory',
    statement: 'insert into audit_events',
  };
  return await diesParkedAt(db, businessId, park, run);
}

/** `run`'s answer once its transaction died while it waited to write its own register row. */
export async function diesAtItsRegisterRow<T>(
  db: ChainDatabase,
  businessId: string,
  attempt: { readonly actorId: string; readonly operationId: string; readonly command: string },
  run: () => Promise<T>,
): Promise<Died<T>> {
  const take = async (tx: TenantQuery): Promise<void> => {
    await tx.query(
      `insert into operations (business_id, id, operation_id, command, actor_id, payload_digest,
         outcome, result) values ($1, $2, $3, $4, $5, repeat('0', 64), 'refused', '{"code":"HELD"}')`,
      [businessId, randomUUID(), attempt.operationId, attempt.command, attempt.actorId],
    );
  };
  const park: Park = {
    take,
    ending: 'rollback',
    event: 'transactionid',
    statement: 'insert into operations',
  };
  return await diesParkedAt(db, businessId, park, run);
}

/** What one operation identity left: its register rows and its audit events, by outcome. */
export async function keptBy(
  admin: Pick<AdminConnection, 'execute'>,
  businessId: string,
  operationId: string,
): Promise<{ readonly operations: number; readonly applied: number; readonly refused: number }> {
  const [row] = await admin.execute<{ operations: number; applied: number; refused: number }>(
    `select (select count(*)::int from public.operations
              where business_id = $1 and operation_id::text = $2) as operations,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id::text = $2 and outcome = 'applied') as applied,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id::text = $2 and outcome = 'refused') as refused`,
    [businessId, operationId],
  );
  return row ?? { operations: 0, applied: 0, refused: 0 };
}
