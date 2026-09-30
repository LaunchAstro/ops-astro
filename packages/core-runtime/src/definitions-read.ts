// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02: the pinned read, the half of `definitions.ts` a run uses while it
// works. It runs under the caller's live lease on the run, held locked while
// it records, resolves nothing by name or path when the pin is missing, and
// hands the bytes back only after their ledger row, the audit copy and the
// read's one audit event are written.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  identityOf,
  isInstructionPath,
  mismatch,
  unavailable,
  type FileIdentity,
  type InstructionSource,
} from './definitions.ts';
import { leaseReason } from './lease-ownership.ts';
import { acquire } from './locks.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** The pinned read's one audit event, written by the caller's audit writer. */
export interface ReadAuditNote {
  readonly runId: string;
  readonly sequence: number;
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface PinnedRead {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly sequence: number;
  readonly isEntry: boolean;
}

export interface ReadRequest {
  /** The worker's live lease on the run, and the actor holding it. */
  readonly leaseId: string;
  readonly holderActorId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly path: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface PinRow {
  readonly ref_kind: string;
  readonly path: string | null;
  readonly manifest: readonly FileIdentity[];
}

/**
 * The pinned read, under the caller's live lease on the run. Nothing is
 * resolved by name or path when the pin is missing. The ledger row, the audit
 * copy and the audit event are written in the caller's transaction before the
 * bytes are handed back.
 */
export async function readPinned(
  tx: TenantQuery,
  request: ReadRequest,
  source: InstructionSource,
  audit: (tx: TenantQuery, note: ReadAuditNote) => Promise<void>,
): Promise<RuntimeResult<PinnedRead>> {
  if (
    !UUID.test(request.leaseId) ||
    !UUID.test(request.runId) ||
    !UUID.test(request.holderActorId)
  ) {
    return notOwned();
  }
  if (!(await leaseHeld(tx, request))) return notOwned();
  const pins = await tx.query<PinRow>(
    `select ref_kind, path, manifest from public.run_definition_pins
      where business_id = $1 and run_id = $2`,
    [tx.businessId, request.runId],
  );
  const pin = pins[0];
  if (pin === undefined || pin.ref_kind !== 'bootstrap_file') return unavailable();
  const expected = pin.manifest.find((entry) => entry.path === request.path);
  if (expected === undefined || !isInstructionPath(request.path)) return mismatch();
  const bytes = await source.read(request.path);
  if (bytes === undefined) return unavailable();
  const identity = identityOf(request.path, bytes);
  if (identity.digest !== expected.digest || identity.size !== expected.size) return mismatch();
  const isEntry = request.path === pin.path && !(await entryRead(tx, request.runId));
  // The record first, the bytes last: if the ledger row, the audit copy or
  // the audit event cannot be written, the statement's error fails the
  // caller's transaction and no bytes are returned.
  const sequence = await recordRead(tx, request, identity, isEntry, bytes);
  await audit(tx, { runId: request.runId, sequence, ...identity });
  return { ok: true, value: { bytes, identity, sequence, isEntry } };
}

/**
 * The caller's lease, taken under the runtime's lock order (class `lease`,
 * the only lock the read takes) and then read as it stands: a release or an
 * expiry committed while the read waited on the row is seen, and judged on the
 * database clock at the moment the lock is held, so the read cannot record
 * against a lease that ended under it.
 */
async function leaseHeld(tx: TenantQuery, request: ReadRequest): Promise<boolean> {
  await acquire(tx, [{ lockClass: 'lease', id: request.leaseId }]);
  const leases = await tx.query(
    `select 1 from public.leases
      where business_id = $1 and id = $2 and run_id = $3 and holder_actor_id = $4
        and state = 'live' and expires_at > clock_timestamp()`,
    [tx.businessId, request.leaseId, request.runId, request.holderActorId],
  );
  return leases.length > 0;
}

async function entryRead(tx: TenantQuery, runId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.bootstrap_reads where business_id = $1 and run_id = $2 and is_entry`,
    [tx.businessId, runId],
  );
  return rows.length > 0;
}

/**
 * The ledger row and the audit copy. The next sequence is read and written in
 * one statement; two reads racing for it meet the unique index, and the loser's
 * transaction fails rather than recording a read twice. The copy is kept once
 * per business and digest; the conflict names no target, so keeping it needs no
 * right to read it.
 */
async function recordRead(
  tx: TenantQuery,
  request: ReadRequest,
  identity: FileIdentity,
  isEntry: boolean,
  bytes: Uint8Array,
): Promise<number> {
  const written = await tx.query<{ sequence: number }>(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, step_id, sequence, path, content_digest, content_size, is_entry)
     select $1, $2, $3, $4,
            coalesce((select max(sequence) from public.bootstrap_reads
                       where business_id = $1 and run_id = $3), 0) + 1,
            $5, $6, $7, $8
     returning sequence`,
    [
      tx.businessId,
      randomUUID(),
      request.runId,
      request.stepId,
      identity.path,
      identity.digest,
      identity.size,
      isEntry,
    ],
  );
  await tx.query(
    `insert into public.bootstrap_bytes (business_id, content_digest, content_size, bytes)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [tx.businessId, identity.digest, identity.size, Buffer.from(bytes)],
  );
  const sequence = written[0]?.sequence;
  if (sequence === undefined) throw new Error('the ledger row was not written');
  return sequence;
}

/** Another business's lease, a made-up one and an ended one read alike. */
function notOwned(): RuntimeResult<never> {
  return refuse(
    'LEASE_NOT_OWNED',
    leaseReason('not_owned'),
    'Read with the live lease your own pickup was issued for this run.',
  );
}
