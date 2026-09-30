// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 on the execution graph: the instruction file a run was pinned to and
// every file it read, under that run's node (`execution-graph.ts`), so the
// app, the API and the command line name them alike (moved from AW-02).
//
// The pin is the run's one `run_definition_pins` row (0192): a bootstrap file
// by path, digest and size, or a definition version, with the accept-time
// manifest's digest. The reads are its `bootstrap_reads` ledger in read
// order, each written by the read itself (`readPinned`), and the set digest
// is the path-sorted one `setDigest` gives. A file's identity is its digest
// and size; the path is provenance only. A run with no pin reads null.

import { setDigest } from '../../../core-runtime/src/index.ts';

export interface DefinitionRead {
  readonly sequence: number;
  readonly entry: boolean;
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface RunDefinition {
  readonly kind: 'bootstrap_file' | 'definition_version';
  /** The bootstrap file's path; null for a definition version. */
  readonly path: string | null;
  /** The definition version's id; null for a bootstrap file. */
  readonly versionId: string | null;
  readonly digest: string;
  readonly size: number;
  readonly manifestDigest: string;
  readonly reads: readonly DefinitionRead[];
  readonly readSet: { readonly digest: string; readonly count: number };
}

/** The run `run`'s pin and read ledger as JSON, or null. `$1` is the business. */
export const DEFINITION_FACTS = `(select json_build_object(
    'kind', pin.ref_kind, 'path', pin.path, 'versionId', pin.definition_version_id,
    'digest', pin.content_digest, 'size', pin.content_size::float8,
    'manifestDigest', pin.manifest_digest,
    'reads', coalesce((select json_agg(json_build_object(
        'sequence', r.sequence, 'entry', r.is_entry, 'path', r.path,
        'digest', r.content_digest, 'size', r.content_size::float8)
        order by r.sequence)
      from public.bootstrap_reads r
      where r.business_id = $1 and r.run_id = run.id), '[]'))
  from public.run_definition_pins pin
  where pin.business_id = $1 and pin.run_id = run.id)`;

const KINDS: ReadonlySet<unknown> = new Set(['bootstrap_file', 'definition_version']);

/** The run facts' `definition`, checked and read; a malformed one throws. */
export function definitionOf(value: unknown, where: string): RunDefinition | null {
  if (value === null) return null;
  const at = `${where}: the definition`;
  if (
    !isRecord(value) ||
    !KINDS.has(value['kind']) ||
    !nullOrString(value['path']) ||
    !nullOrString(value['versionId']) ||
    typeof value['digest'] !== 'string' ||
    !isSize(value['size']) ||
    typeof value['manifestDigest'] !== 'string' ||
    !Array.isArray(value['reads'])
  )
    throw new Error(`${at} is malformed`);
  const reads = value['reads'].map((read: unknown, index) => {
    if (
      !isRecord(read) ||
      !isSize(read['sequence']) ||
      typeof read['entry'] !== 'boolean' ||
      typeof read['path'] !== 'string' ||
      typeof read['digest'] !== 'string' ||
      !isSize(read['size'])
    )
      throw new Error(`${at}: read ${String(index)} is malformed`);
    return read as unknown as DefinitionRead;
  });
  return {
    ...(value as unknown as Omit<RunDefinition, 'reads' | 'readSet'>),
    reads,
    readSet: setDigest(reads),
  };
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullOrString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
