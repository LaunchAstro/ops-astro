// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 Sol R1: one proof per finding of Sol's first review of the publish and
// revert executable (PR #363), each against doubles of the source control and
// hosting connectors. The call's own proofs are in c80-hostile-provider.

import { describe, expect, it } from 'vitest';
import {
  contentDigest,
  publishCorrection,
  revertCorrection,
  versionDigestOf,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';

type RevertPorts = Parameters<typeof revertCorrection>[1];

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

  it('Sol R1 3: cancellation during the drift read prevents dispatch', async () => {
    const sent: string[] = [];
    let cancelled = false;
    const ports = publishPorts(sent, {
      readSource: () => {
        cancelled = true;
        return Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'abc123' } });
      },
      cancellation: () => Promise.resolve(cancelled ? 'requested' : 'none'),
    });
    const outcome = await publishCorrection(approvedJob(), ports);
    expect({ sent, outcome }).toEqual({
      sent: [],
      outcome: { state: 'refused', code: 'CANCELLED' },
    });
  });

  it('Sol R1 4: an unknown publish is not dispatched blind on retry', async () => {
    const sent: string[] = [];
    let landed = false;
    const ports = {
      ...publishPorts(sent, {
        publish: (input) => {
          sent.push(input.seam);
          return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
        },
      }),
      // After an uncertain send the seam cannot tell, until the merge shows.
      readBack: () => {
        if (landed) return Promise.resolve({ state: 'landed' as const, value: PUBLISHED });
        return Promise.resolve({
          state: sent.length === 0 ? ('absent' as const) : ('unknown' as const),
        });
      },
    };
    expect((await publishCorrection(approvedJob(), ports)).state).toBe('unknown');
    expect((await publishCorrection(approvedJob(), ports)).state).toBe('unknown');
    expect(sent).toHaveLength(1);
    landed = true;
    expect(await publishCorrection(approvedJob(), ports)).toMatchObject({
      state: 'accepted',
      ...PUBLISHED,
    });
    expect(sent).toHaveLength(1);
  });
});

const T0 = Date.parse('2026-10-04T00:00:00Z');
const REVERTED = { revision: 'rev789', deploymentId: 'dpl_2' };
const revertInput = {
  publishedRevision: 'def456',
  target: TARGET,
  change: CHANGE,
  seam: 'revert-of-def456',
  decidedAt: T0,
};
const page = (text: string) => () => Promise.resolve({ ok: true as const, value: { text } });

/** Ports whose seam reads back nothing before the first send and the revert after it, served. */
function revertPorts(sent: string[], overrides: Partial<RevertPorts> = {}): RevertPorts {
  const ports = {
    now: () => T0 + 1_000,
    revert: (input: { seam: string }) => {
      sent.push(input.seam);
      return Promise.resolve({ kind: 'ok' as const, value: REVERTED });
    },
    readBack: () =>
      Promise.resolve(
        sent.length === 0
          ? { state: 'absent' as const }
          : { state: 'landed' as const, value: REVERTED },
      ),
    readDeployment: () =>
      Promise.resolve({ kind: 'ok' as const, value: { revision: 'rev789', served: true } }),
    capture: page('We walk alongside you.'),
    ...overrides,
  };
  return ports;
}

describe('C80 Sol R1 proofs (revert)', () => {
  it('Sol R1 5: an unknown revert is not dispatched blind on retry', async () => {
    const sent: string[] = [];
    let landed = false;
    const ports = {
      ...revertPorts(sent, {
        revert: (input) => {
          sent.push(input.seam);
          return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
        },
      }),
      // After an uncertain send the seam cannot tell, until the branch head shows the revert.
      readBack: () => {
        if (landed) return Promise.resolve({ state: 'landed' as const, value: REVERTED });
        return Promise.resolve({
          state: sent.length === 0 ? ('absent' as const) : ('unknown' as const),
        });
      },
    };
    expect((await revertCorrection(revertInput, ports)).state).toBe('unknown');
    expect((await revertCorrection(revertInput, ports)).state).toBe('unknown');
    expect(sent).toHaveLength(1);
    landed = true;
    expect(await revertCorrection(revertInput, ports)).toMatchObject({
      state: 'reverted',
      ...REVERTED,
    });
    expect(sent).toHaveLength(1);
  });
});
