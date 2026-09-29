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

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { RuntimeResult } from './refusals.ts';

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

const notBuilt = (): never => {
  throw new Error('AW-02: not built');
};

export function isInstructionPath(_path: unknown): _path is string {
  return notBuilt();
}

export function identityOf(_path: string, _bytes: Uint8Array): FileIdentity {
  return notBuilt();
}

export function setDigest(_reads: readonly FileIdentity[]): {
  readonly digest: string;
  readonly count: number;
} {
  return notBuilt();
}

export function admitActivation(_request: ActivationRequest): RuntimeResult<AdmittedActivation> {
  return notBuilt();
}

export async function captureManifest(
  _source: InstructionSource,
  _paths: readonly string[],
): Promise<RuntimeResult<CapturedManifest>> {
  return await Promise.reject(new Error('AW-02: not built'));
}

export async function pinBootstrapFile(
  _tx: TenantQuery,
  _activation: AdmittedActivation,
  _pin: { readonly runId: string; readonly entryPath: string; readonly manifest: CapturedManifest },
): Promise<RuntimeResult<FileIdentity>> {
  return await Promise.reject(new Error('AW-02: not built'));
}

export async function readPinned(
  _tx: TenantQuery,
  _request: ReadRequest,
  _source: InstructionSource,
  _audit: (tx: TenantQuery, note: ReadAuditNote) => Promise<void>,
): Promise<RuntimeResult<PinnedRead>> {
  return await Promise.reject(new Error('AW-02: not built'));
}
