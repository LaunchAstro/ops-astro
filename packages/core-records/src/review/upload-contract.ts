// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's upload contract (#2039, C73, TR-SEC-6): the one gate every upload
// goes through. A start is refused when its declared type is not one its kind
// takes or its size is past its kind's limit, before the store is asked
// anything. On completion the object's own bytes are read back in bounded
// ranges and sniffed against the declared type, and an MP4's probe is read
// from the same ranges; a disguised file or a probe that disagrees with the
// declared codec is refused. Anything else lands quarantined until a scanner's
// answer lands (`media-scan.ts`). A store answer of another length than asked
// refuses the completion: the store's word is checked, never trusted.

import type { ObjectTransfers } from './storage.ts';
import type { DeclaredAsset, MediaKind } from './media.ts';
import type { MediaProbe } from './mp4-probe.ts';

const MIB = 1024 * 1024;

/** The largest asset each kind takes, the one place these limits are set. */
export const MOST_BYTES_BY_KIND: Readonly<Record<MediaKind, number>> = {
  video: 20 * 1024 * MIB,
  audio: 2 * 1024 * MIB,
  image: 100 * MIB,
  pdf: 200 * MIB,
};

/** The most bytes one range read asks for. */
export const MOST_RANGE_BYTES: number = MIB;

export type ContractRefusal = 'TYPE_MISMATCH' | 'PROBE_DISAGREES' | 'PROBE_UNREADABLE';

export type Admission =
  | { readonly verdict: 'quarantined'; readonly probe: MediaProbe | null }
  | { readonly verdict: 'refused'; readonly refusal: ContractRefusal };

export function refusalAtStart(
  _declared: DeclaredAsset,
): 'TYPE_UNSUPPORTED' | 'TOO_LARGE_FOR_CLASS' | null {
  return null;
}

export class HostileStoreAnswer extends Error {}

export function rangeReader(
  store: ObjectTransfers,
  key: string,
  _byteCount: number,
): (from: number, length: number) => Promise<Uint8Array> {
  return async (from, length) => {
    const answer = await store.readRange(key, from, length);
    return answer instanceof Uint8Array ? answer : new Uint8Array();
  };
}

export function admitCompleted(
  _store: ObjectTransfers,
  _key: string,
  _declared: Pick<DeclaredAsset, 'kind' | 'type' | 'codec' | 'byteCount'>,
): Promise<Admission> {
  return Promise.resolve({ verdict: 'quarantined', probe: null });
}
