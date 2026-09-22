// SPDX-License-Identifier: AGPL-3.0-only
//
// Writing an audit event, and checking the chain.
//
// Every attempt writes one event, refusals included (minimum contract 4.2,
// audit row). That clause is what makes a deliberate cross-business probe
// visible to an operator while staying invisible to the prober: the caller
// sees `NOT_FOUND`, the chain records `WRONG_BUSINESS`.
//
// Nothing here computes a hash. The position and the chain links are written
// by the trigger inside the same statement, from one formula the verifier also
// calls, because two copies of a hash formula produce a verifier that agrees
// with the writer about a chain neither computes correctly.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { RefusalCode } from './register.ts';

export type AuditOutcome = 'applied' | 'refused' | 'replayed' | 'failed';

/** What the insert names for a column the trigger is about to write anyway. */
const PLACEHOLDER_HASH = '0'.repeat(64);

export interface AuditEvent {
  readonly actorId: string;
  readonly command: string;
  readonly operationId?: string | null;
  readonly outcome: AuditOutcome;
  readonly refusalCode?: RefusalCode | null;
  readonly subjectRecordId?: string | null;
  readonly payloadDigest: string;
  /** Only the keys a spoof attempt carried. Never the whole payload. */
  readonly attempted?: Readonly<Record<string, unknown>> | null;
  /**
   * Offered by a caller and ignored by the server. They are here so a test can
   * present them and watch them not persist; nothing in the product supplies
   * them, and the trigger overwrites all three.
   */
  readonly seq?: string;
  readonly prevHash?: string;
  readonly hash?: string;
}

export interface WrittenAuditEvent {
  readonly id: string;
  readonly seq: string;
  readonly hash: string;
}

export interface AuditEventRow {
  readonly id: string;
  readonly seq: string;
  readonly occurred_at: Date;
  readonly actor_id: string;
  readonly command: string;
  readonly operation_id: string | null;
  readonly outcome: AuditOutcome;
  readonly refusal_code: string | null;
  readonly subject_record_id: string | null;
  readonly payload_digest: string;
  readonly attempted: Readonly<Record<string, unknown>> | null;
  readonly prev_hash: string | null;
  readonly hash: string;
}

/** Write one event. The position, the link and the hash come back from the server. */
export async function writeAuditEvent(
  tx: TenantQuery,
  event: AuditEvent,
): Promise<WrittenAuditEvent> {
  // `seq`, `prev_hash` and `hash` are `not null`, so the insert has to name
  // them, and what it names is whatever the caller offered — a placeholder
  // when nothing was offered, which is what the product always sends. They
  // reach the server on purpose: the trigger overwrites all three, and a
  // column the insert never mentioned could not have been shown to be
  // overwritten.
  const rows = await tx.query<WrittenAuditEvent>(
    `insert into audit_events
       (business_id, id, actor_id, command, operation_id, outcome, refusal_code,
        subject_record_id, payload_digest, attempted, seq, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11, $12, $13)
     returning id, seq::text as seq, hash`,
    [
      tx.businessId,
      randomUUID(),
      event.actorId,
      event.command,
      event.operationId ?? null,
      event.outcome,
      event.refusalCode ?? null,
      event.subjectRecordId ?? null,
      event.payloadDigest,
      event.attempted ?? null,
      event.seq ?? '1',
      event.prevHash ?? null,
      event.hash ?? PLACEHOLDER_HASH,
    ],
  );
  const written = rows[0];
  if (written === undefined) throw new Error('writeAuditEvent: the insert returned no row');
  return written;
}

/** This business's chain, in order. */
export async function readAuditEvents(tx: TenantQuery): Promise<readonly AuditEventRow[]> {
  return await tx.query<AuditEventRow>(
    `select id, seq::text as seq, occurred_at, actor_id, command, operation_id, outcome,
            refusal_code, subject_record_id, payload_digest, attempted, prev_hash, hash
       from audit_events a
      where a.business_id = $1
      order by a.seq`,
    [tx.businessId],
  );
}

/** Every event about one record, for the history a task page draws. */
export async function readRecordAudit(
  tx: TenantQuery,
  recordId: string,
): Promise<readonly AuditEventRow[]> {
  return await tx.query<AuditEventRow>(
    `select id, seq::text as seq, occurred_at, actor_id, command, operation_id, outcome,
            refusal_code, subject_record_id, payload_digest, attempted, prev_hash, hash
       from audit_events a
      where a.business_id = $1 and a.subject_record_id = $2
      order by a.seq`,
    [tx.businessId, recordId],
  );
}

export type BreakReason = 'hash' | 'link' | 'gap';

export interface ChainReport {
  readonly intact: boolean;
  readonly length: number;
  /** The first position where the chain stops adding up, or nothing. */
  readonly firstBreak: { readonly seq: string; readonly reason: BreakReason } | undefined;
}

interface VerifyRow {
  readonly seq: string;
  readonly hash: string;
  readonly recomputed: string;
  readonly prev_hash: string | null;
  readonly previous_hash: string | null;
}

/**
 * Walk the chain and check three things, because a chain breaks three ways.
 *
 * A row changed after it was written no longer hashes to its stored hash. A
 * row whose `prev_hash` does not match the hash of the row before it has been
 * moved or reordered. And a missing row leaves a gap in the positions, which
 * is the break a per-row hash on its own cannot see — the surviving rows all
 * still hash correctly.
 */
export async function verifyAuditChain(tx: TenantQuery): Promise<ChainReport> {
  const rows = await tx.query<VerifyRow>(
    `select a.seq::text as seq,
            a.hash,
            public.audit_event_hash(a.prev_hash, a.business_id, a.seq, a.occurred_at, a.actor_id,
              a.command, a.operation_id, a.outcome, a.refusal_code, a.subject_record_id,
              a.payload_digest, a.attempted) as recomputed,
            a.prev_hash,
            lag(a.hash) over (order by a.seq) as previous_hash
       from audit_events a
      where a.business_id = $1
      order by a.seq`,
    [tx.businessId],
  );

  let expected = 1n;
  for (const row of rows) {
    if (BigInt(row.seq) !== expected) {
      return { intact: false, length: rows.length, firstBreak: { seq: row.seq, reason: 'gap' } };
    }
    if (row.hash !== row.recomputed) {
      return { intact: false, length: rows.length, firstBreak: { seq: row.seq, reason: 'hash' } };
    }
    if (row.prev_hash !== row.previous_hash) {
      return { intact: false, length: rows.length, firstBreak: { seq: row.seq, reason: 'link' } };
    }
    expected += 1n;
  }

  return { intact: true, length: rows.length, firstBreak: undefined };
}
