// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 approved bytes: the store keeps digests, never the file's text, so the
// runner rebuilds the approved change from the pinned source. Only the
// occurrence whose version digest is the approved one is the change: a decoy
// of the same word earlier in the file is never the one published, and bytes
// no occurrence can produce are no change at all.

import { describe, expect, it } from 'vitest';
import {
  approvedChange,
  contentDigest,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';

const TARGET = { path: 'src/pages/about.md', word: 'friendly', replacement: 'welcoming' };
const BEFORE = 'A friendly decoy line.\n\nWe are a friendly studio.\n';
const AFTER = 'A friendly decoy line.\n\nWe are a welcoming studio.\n';
const PIN = {
  target: TARGET,
  preImageDigest: contentDigest(BEFORE),
  baseRevision: 'rev-1',
  pageUrl: 'https://agency.example/about/',
};
const APPROVED = versionDigestOf({
  ...PIN,
  change: { files: [{ path: TARGET.path, before: BEFORE, after: AFTER }] },
});

describe('C80 approved bytes', () => {
  it('rebuilds the approved occurrence, not the decoy before it', () => {
    expect(approvedChange(PIN, BEFORE, APPROVED)).toEqual({
      files: [{ path: TARGET.path, before: BEFORE, after: AFTER }],
    });
  });

  it('rebuilds nothing when no occurrence gives the approved digest', () => {
    expect(approvedChange(PIN, BEFORE, contentDigest('another version'))).toBeUndefined();
    expect(approvedChange({ ...PIN, baseRevision: 'rev-2' }, BEFORE, APPROVED)).toBeUndefined();
    expect(approvedChange(PIN, BEFORE.replace('studio', 'shop'), APPROVED)).toBeUndefined();
  });

  it('binds the page and the base revision into the version digest', () => {
    const change = { files: [{ path: TARGET.path, before: BEFORE, after: AFTER }] };
    expect(versionDigestOf({ ...PIN, change, pageUrl: 'https://agency.example/team/' })).not.toBe(
      APPROVED,
    );
    expect(versionDigestOf({ ...PIN, change, baseRevision: 'rev-0' })).not.toBe(APPROVED);
  });
});
