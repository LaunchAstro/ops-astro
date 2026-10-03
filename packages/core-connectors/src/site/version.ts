// SPDX-License-Identifier: AGPL-3.0-only
//
// What a live correction's version is: the digest its approval binds to, and
// the approved change rebuilt from the pinned source. The request stores this
// digest and the executable checks it, so both compute it here, one way.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import { wordOffsets, type CorrectionTarget, type ProposedChange } from './envelope.ts';

export function contentDigest(value: unknown): string {
  return `sha256:${payloadDigest(value)}`;
}

/** What a correction's version pins: the approval binds to this digest and nothing else. */
export interface VersionPin {
  readonly target: CorrectionTarget;
  readonly change: ProposedChange;
  readonly preImageDigest: string;
  readonly baseRevision: string;
  readonly pageUrl: string;
}

/** The version digest, computed one way where the request stores it and where the publish checks it. */
export function versionDigestOf(pin: VersionPin): string {
  return contentDigest({
    target: pin.target,
    change: pin.change,
    preImageDigest: pin.preImageDigest,
    baseRevision: pin.baseRevision,
    pageUrl: pin.pageUrl,
  });
}

/**
 * The approved change, rebuilt from the pinned source: the store keeps digests,
 * never the file's text. Each standalone occurrence of the word is tried, and
 * only the one whose version digest is the approved one is the change;
 * anything else is not the approved bytes and is undefined.
 */
export function approvedChange(
  pin: Omit<VersionPin, 'change'>,
  before: string,
  approvedDigest: string,
): ProposedChange | undefined {
  const { path, word, replacement } = pin.target;
  for (const at of wordOffsets(before, word)) {
    const after = before.slice(0, at) + replacement + before.slice(at + word.length);
    const change = { files: [{ path, before, after }] };
    if (versionDigestOf({ ...pin, change }) === approvedDigest) return change;
  }
  return undefined;
}
