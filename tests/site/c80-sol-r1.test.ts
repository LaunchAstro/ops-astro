// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 Sol R1: one proof per finding of Sol's first review of the publish and
// revert executable (PR #363), each against doubles of the source control and
// hosting connectors. The call's own proofs are in c80-hostile-provider.

import { describe, expect, it } from 'vitest';
import {
  contentDigest,
  publishCorrection,
  versionDigestOf,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};
const BEFORE = '<p>We walk alongside you.</p>\n';
const CHANGE = {
  files: [{ path: TARGET.path, before: BEFORE, after: '<p>We walk beside you.</p>\n' }],
};
const PUBLISHED = {
  revision: 'def456',
  deploymentId: 'dpl_1',
  liveUrl: 'https://agency.example/about/',
};

/** A job approved for the publish reference `seam`, its digest computed as the request stores it. */
function approvedJob(seam = 'request-17'): PublishJob {
  const pinned = {
    target: TARGET,
    change: CHANGE,
    preImageDigest: contentDigest(BEFORE),
    baseRevision: 'abc123',
    pageUrl: PUBLISHED.liveUrl,
    seam,
  };
  const digest = versionDigestOf(pinned);
  return {
    correctionId: 'correction-1',
    ...pinned,
    version: { versionId: 'version-2', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-2',
      versionDigest: digest,
    },
  };
}

/** Ports whose seam reads back nothing before the first send and the publish after it. */
function publishPorts(sent: string[], overrides: Partial<PublishPorts> = {}): PublishPorts {
  const ports = {
    readSource: () =>
      Promise.resolve({ kind: 'ok' as const, value: { content: BEFORE, revision: 'abc123' } }),
    publish: (input: { seam: string }) => {
      sent.push(input.seam);
      return Promise.resolve({ kind: 'ok' as const, value: PUBLISHED });
    },
    readBack: () =>
      Promise.resolve(
        sent.length === 0
          ? { state: 'absent' as const }
          : { state: 'landed' as const, value: PUBLISHED },
      ),
    cancellation: () => Promise.resolve('none' as const),
    raiseTask: () => Promise.resolve(),
    ...overrides,
  };
  return ports;
}

describe('C80 Sol R1 proofs (publish)', () => {
  it('Sol R1 2: approval for one publish reference cannot authorise another', async () => {
    const sent: string[] = [];
    const approved = approvedJob('request-17');
    const outcome = await publishCorrection(
      { ...approved, seam: 'request-unapproved' },
      publishPorts(sent),
    );
    expect({ sent, outcome }).toEqual({
      sent: [],
      outcome: { state: 'refused', code: 'PROPOSAL_SUPERSEDED' },
    });
  });
});
