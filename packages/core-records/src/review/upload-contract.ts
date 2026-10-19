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
import { probeMp4, type MediaProbe } from './mp4-probe.ts';

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

const HEAD_BYTES = 64 * 1024;

export type ContractRefusal = 'TYPE_MISMATCH' | 'PROBE_DISAGREES' | 'PROBE_UNREADABLE';

export type Admission =
  | { readonly verdict: 'quarantined'; readonly probe: MediaProbe | null }
  | { readonly verdict: 'refused'; readonly refusal: ContractRefusal };

const ascii = (bytes: Uint8Array, from: number, length: number): string =>
  String.fromCodePoint(...bytes.subarray(from, from + length));

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

const isRiff = (bytes: Uint8Array, form: string): boolean =>
  ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === form;

/** An ISO base media file (MP4) by its leading `ftyp` box, not QuickTime's own brand. */
const isMp4 = (bytes: Uint8Array): boolean =>
  ascii(bytes, 4, 4) === 'ftyp' && ascii(bytes, 8, 4) !== 'qt  ';

/** An MPEG audio frame's sync with a layer set: MP3's; ADTS (AAC) has the layer clear. */
const isMpegAudioFrame = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) !== 0;
const isAdts = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;

/** Each declared type a kind takes, and what its first bytes must be. */
const SNIFFED: Readonly<
  Record<MediaKind, Readonly<Record<string, (head: Uint8Array) => boolean>>>
> = {
  video: { 'video/mp4': isMp4 },
  audio: {
    'audio/mp4': isMp4,
    'audio/mpeg': (head) => ascii(head, 0, 3) === 'ID3' || isMpegAudioFrame(head),
    'audio/wav': (head) => isRiff(head, 'WAVE'),
    'audio/flac': (head) => ascii(head, 0, 4) === 'fLaC',
    'audio/aac': isAdts,
  },
  image: {
    'image/jpeg': (head) => startsWith(head, [0xff, 0xd8, 0xff]),
    'image/png': (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/webp': (head) => isRiff(head, 'WEBP'),
  },
  pdf: { 'application/pdf': (head) => ascii(head, 0, 5) === '%PDF-' },
};

/** A declaration the contract refuses before an upload starts, or none. */
export function refusalAtStart(
  declared: DeclaredAsset,
): 'TYPE_UNSUPPORTED' | 'TOO_LARGE_FOR_CLASS' | null {
  if (!Object.hasOwn(SNIFFED[declared.kind], declared.type)) return 'TYPE_UNSUPPORTED';
  if (declared.byteCount > MOST_BYTES_BY_KIND[declared.kind]) return 'TOO_LARGE_FOR_CLASS';
  return null;
}

/** The store answered other bytes than asked. */
export class HostileStoreAnswer extends Error {
  constructor() {
    super('the store answered another length than the range asked');
  }
}

/**
 * A completed object's bytes by range, each read bounded and checked: the head read once and
 * served from memory, any other range asked of the store. An answer of another length than
 * the object holds there throws `HostileStoreAnswer`.
 */
export function rangeReader(
  store: ObjectTransfers,
  key: string,
  byteCount: number,
): (from: number, length: number) => Promise<Uint8Array> {
  let head: Uint8Array | undefined;
  const read = async (from: number, length: number): Promise<Uint8Array> => {
    const expected = Math.max(0, Math.min(length, MOST_RANGE_BYTES, byteCount - from));
    const answer = await store.readRange(key, from, expected);
    if (!(answer instanceof Uint8Array) || answer.byteLength !== expected)
      throw new HostileStoreAnswer();
    return answer;
  };
  return async (from, length) => {
    head ??= await read(0, HEAD_BYTES);
    return from + length <= head.byteLength
      ? head.subarray(from, from + length)
      : await read(from, length);
  };
}

/**
 * The contract on a completed object of a declared asset: sniffed, then probed when it is a
 * video. Throws `HostileStoreAnswer` when a range read is answered with another length.
 */
export async function admitCompleted(
  store: ObjectTransfers,
  key: string,
  declared: Pick<DeclaredAsset, 'kind' | 'type' | 'codec' | 'byteCount'>,
): Promise<Admission> {
  const read = rangeReader(store, key, declared.byteCount);
  const sniff = SNIFFED[declared.kind][declared.type];
  if (sniff === undefined || !sniff(await read(0, 16)))
    return { verdict: 'refused', refusal: 'TYPE_MISMATCH' };
  if (declared.kind !== 'video') return { verdict: 'quarantined', probe: null };
  const probe = await probeMp4(read, declared.byteCount);
  if (probe === undefined) return { verdict: 'refused', refusal: 'PROBE_UNREADABLE' };
  if (probe.codec !== declared.codec?.split('.')[0])
    return { verdict: 'refused', refusal: 'PROBE_DISAGREES' };
  return { verdict: 'quarantined', probe };
}
