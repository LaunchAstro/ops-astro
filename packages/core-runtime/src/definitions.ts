// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02: a run is pinned to the exact instruction file it runs with.
//
// A file's identity is its digest and its size; the path is provenance only.
// Five pieces, all first used by AW-04's plan accept, which is the only
// activation there is:
//
//   admitActivation   the refusal of every activation that is not a person's
//                     manual act. A bootstrap file has no activation modes, so
//                     a schedule, an event or a timer naming one is refused
//                     here, before any run row exists, and an agent is refused
//                     whatever mode it names.
//   captureManifest   the accept-time manifest: every instruction file the run
//                     may read, by path, digest and size, sorted by path.
//   pinBootstrapFile  the pin, in the run's definition reference slot, with
//                     the manifest beside it. It takes only an admitted
//                     activation, so nothing reaches it round the refusal.
//   readPinned        the pinned read. It resolves nothing by name or path
//                     alone: no pin, no bytes. The bytes must match the pin's
//                     manifest by digest and size. The read writes its own
//                     ledger row, keeps the audit copy and writes its one
//                     audit event in the caller's transaction before it hands
//                     the bytes back; a read that cannot be recorded fails
//                     the transaction and returns no bytes.
//   setDigest         the path-sorted set digest over a run's ledger.
//
// There is no file-system access here. The bytes come from an
// `InstructionSource` the process that holds the files supplies.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { leaseReason } from './lease-ownership.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** How an activation fires. A bootstrap file permits `manual` alone. */
export type ActivationMode = 'manual' | 'schedule' | 'event' | 'timer';

/** Who asks for the activation. A schedule, event or timer fires as the system. */
export interface Activator {
  readonly kind: 'person' | 'agent' | 'system';
  readonly actorId: string | null;
}

export interface ActivationRequest {
  readonly mode: string;
  readonly activator: Activator;
}

declare const admitted: unique symbol;

/** Proof the refusal ran: only `admitActivation` makes one. */
export interface AdmittedActivation {
  readonly [admitted]: true;
  readonly actorId: string;
}

/** One instruction file, by identity. */
export interface FileIdentity {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface CapturedManifest {
  readonly entries: readonly FileIdentity[];
  readonly digest: string;
}

/** Where instruction bytes come from. `undefined` is an unreadable file. */
export interface InstructionSource {
  read(path: string): Promise<Uint8Array | undefined>;
}

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
const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DOTS = /(?:^|\/)\.\.?(?:\/|$)/u;

/** A relative path of plain segments: no leading slash, no `.` or `..`, no odd characters. */
export function isInstructionPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 512 && PATH.test(path) && !DOTS.test(path);
}

export function identityOf(path: string, bytes: Uint8Array): FileIdentity {
  return { path, digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const byPath = (a: FileIdentity, b: FileIdentity): number =>
  a.path < b.path
    ? -1
    : a.path > b.path
      ? 1
      : a.digest < b.digest
        ? -1
        : a.digest > b.digest
          ? 1
          : 0;

const lines = (entries: readonly FileIdentity[]): string =>
  entries.map((entry) => `${entry.digest} ${String(entry.size)} ${entry.path}\n`).join('');

/**
 * The set digest over a run's reads: distinct `<digest> <size> <path>`
 * triples, sorted by path, one per line, SHA-256. Read order is not part of
 * it; it stays in the ledger's `sequence`.
 */
export function setDigest(reads: readonly FileIdentity[]): {
  readonly digest: string;
  readonly count: number;
} {
  const distinct = new Map<string, FileIdentity>();
  for (const read of reads) distinct.set(lines([read]), read);
  const sorted = [...distinct.values()].toSorted(byPath);
  return { digest: sha256(lines(sorted)), count: sorted.length };
}

/**
 * The refusal of every activation that is not a person's manual act. It runs
 * first, before any run row is written. The person's `gate:decide` is the plan
 * accept's own check (AW-04, through `decide.ts`), taken in the same
 * transaction.
 */
export function admitActivation(request: ActivationRequest): RuntimeResult<AdmittedActivation> {
  const { mode, activator } = request;
  if (activator.kind === 'agent') {
    return refuse(
      'DELEGATION_EXCLUDES_ACTIVATION',
      'an agent may not activate an instruction file, in any mode',
      'A person accepts the plan that runs it.',
    );
  }
  if (mode !== 'manual' || activator.kind !== 'person' || activator.actorId === null) {
    return refuse(
      'ACTIVATION_MODE_NOT_PERMITTED',
      'an instruction file has no activation modes: only a person activates it, by hand',
      'A person accepts the plan that runs it; a schedule, event or timer never does.',
    );
  }
  return { ok: true, value: { actorId: activator.actorId } as AdmittedActivation };
}

/** Every file the run may read, captured at accept time. */
export async function captureManifest(
  source: InstructionSource,
  paths: readonly string[],
): Promise<RuntimeResult<CapturedManifest>> {
  const entries: FileIdentity[] = [];
  for (const path of new Set(paths)) {
    if (!isInstructionPath(path)) return unavailable();
    // Sequential: one file at a time, in the order asked.
    // eslint-disable-next-line no-await-in-loop
    const bytes = await source.read(path);
    if (bytes === undefined) return unavailable();
    entries.push(identityOf(path, bytes));
  }
  const sorted = entries.toSorted(byPath);
  return { ok: true, value: { entries: sorted, digest: sha256(lines(sorted)) } };
}

/**
 * The run's pin, in its definition reference slot, with the accept-time
 * manifest. The entry file must be in the manifest.
 */
export async function pinBootstrapFile(
  tx: TenantQuery,
  activation: AdmittedActivation,
  pin: { readonly runId: string; readonly entryPath: string; readonly manifest: CapturedManifest },
): Promise<RuntimeResult<FileIdentity>> {
  const entry = pin.manifest.entries.find((candidate) => candidate.path === pin.entryPath);
  if (entry === undefined) return mismatch();
  await tx.query(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', $3, $4, $5, now(), $6::text::jsonb, $7, $8)`,
    [
      tx.businessId,
      pin.runId,
      entry.path,
      entry.digest,
      entry.size,
      JSON.stringify(pin.manifest.entries),
      pin.manifest.digest,
      activation.actorId,
    ],
  );
  return { ok: true, value: entry };
}

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
  const leases = await tx.query(
    `select 1 from public.leases
      where business_id = $1 and id = $2 and run_id = $3 and holder_actor_id = $4
        and state = 'live' and expires_at > now()`,
    [tx.businessId, request.leaseId, request.runId, request.holderActorId],
  );
  if (leases.length === 0) return notOwned();
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

function unavailable(): RuntimeResult<never> {
  return refuse(
    'DEFINITION_UNAVAILABLE',
    'the pinned instruction file cannot be read at its exact identity',
    'Nothing is resolved by name or path; restore the file the run pinned, or start a new run.',
  );
}

function mismatch(): RuntimeResult<never> {
  return refuse(
    'DEFINITION_DIGEST_MISMATCH',
    "the file's bytes are not the ones the run pinned at accept",
    'A changed file is a new file; accept a new plan to run it.',
  );
}
