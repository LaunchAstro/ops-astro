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
//   readPinned        the pinned read (`definitions-read.ts`). It resolves nothing by name or path
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

import { createHash } from 'node:crypto';
import { refuseCommand } from '../../core-records/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
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
  /**
   * Whether the store itself can be read now (AW-04 pin recovery). A store
   * that is down makes every file unreadable, and that is our fault, not the
   * plan's; a source without this answers per file only.
   */
  available?(): Promise<boolean>;
}

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
  if (source.available !== undefined && !(await source.available())) return storeUnavailable();
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

export function unavailable(): RuntimeResult<never> {
  return refuse(
    'DEFINITION_UNAVAILABLE',
    'the pinned instruction file cannot be read at its exact identity',
    'Nothing is resolved by name or path; restore the file the run pinned, or start a new run.',
  );
}

/**
 * The store the files are read from is down at the accept: our fault, named
 * as such, and the person told that nothing was approved and no run started.
 */
export function storeUnavailable(): RuntimeResult<never> {
  return {
    ok: false,
    refusal: refuseCommand(
      'DEFINITION_UNAVAILABLE',
      ['fault: ours'],
      [
        "The instruction store could not be read, so nothing was approved and no run started. The fault is ours, not your plan's.",
        'Your plan is kept as it was; accept it again once the store is back.',
      ],
    ),
  };
}

export function mismatch(): RuntimeResult<never> {
  return refuse(
    'DEFINITION_DIGEST_MISMATCH',
    "the file's bytes are not the ones the run pinned at accept",
    'A changed file is a new file; accept a new plan to run it.',
  );
}
