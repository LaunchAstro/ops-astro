// SPDX-License-Identifier: AGPL-3.0-only
//
// The socket proxy's one record file (docs/plan/sandbox-contract.md, P3):
// the candidate book and the container book together, so that a create's
// container id and its candidate count land in one write. It is read back
// as text, so `readProxyRecord` is a closed reader: exactly the two keys,
// each book read as its own module reads it. Any break is `internal`.

import { bookOf, bookValue, type CandidateBook } from './candidate-book.ts';
import { type ContainerBook, containerBookOf } from './container-book.ts';
import { fault, type SandboxResult } from './refusal.ts';
import { hasExactKeys, isJsonObject, parseStrictJson } from './strict-json.ts';

export type ProxyRecord = {
  readonly candidates: CandidateBook;
  readonly containers: ContainerBook;
};

export const writeProxyRecord = (record: ProxyRecord): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      candidateBook: bookValue(record.candidates),
      containerBook: record.containers,
    }),
  );

export function readProxyRecord(bytes: Uint8Array): SandboxResult<{ record: ProxyRecord }> {
  const read = parseStrictJson(bytes);
  if (!read.ok) return fault('proxy record');
  const { value } = read;
  if (!hasExactKeys(value, ['candidateBook', 'containerBook']) || !isJsonObject(value))
    return fault('proxy record');
  const candidates = bookOf(value['candidateBook'] ?? null);
  const containers = containerBookOf(value['containerBook'] ?? null);
  return candidates.ok && containers.ok
    ? { ok: true, record: { candidates: candidates.book, containers: containers.book } }
    : fault('proxy record');
}
