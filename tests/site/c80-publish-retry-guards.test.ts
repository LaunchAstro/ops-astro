// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 Sol R1: one proof per finding of Sol's first review of the publish and
// revert executable (PR #363), each against doubles of the source control and
// hosting connectors. The call's own proofs are in c80-hostile-provider.

import { expect, it } from 'vitest';
import {
  contentDigest,
  observeLanded,
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

const page = (text: string) => () =>
  Promise.resolve({ ok: true as const, value: { text, url: PUBLISHED.liveUrl } });

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
    capture: page('We walk alongside you.'),
    ...overrides,
  };
  return ports;
}

it('approval for one publish reference cannot authorise another', async () => {
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

it('cancellation during the drift read prevents dispatch', async () => {
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

it('an unknown publish is not dispatched blind on retry', async () => {
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

const T0 = Date.parse('2026-10-04T00:00:00Z');
const REVERTED = { revision: 'rev789', deploymentId: 'dpl_2' };
const revertInput = {
  publishedRevision: 'def456',
  target: TARGET,
  occurrence: {
    left: 'We walk ',
    right: ' you.',
    index: 0,
    observed: ['beside'],
    offsets: [0],
    liveAt: PUBLISHED.liveUrl,
  },
  seam: 'revert-of-def456',
  decidedAt: T0,
};

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
    raiseTask: () => Promise.resolve(),
    ...overrides,
  };
  return ports;
}

it('an unknown revert is not dispatched blind on retry', async () => {
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

it('a pending revert keeps the original decision time until observation', async () => {
  let now = T0;
  let served = false;
  const ports = revertPorts([], {
    now: () => now,
    readDeployment: () => Promise.resolve({ kind: 'ok', value: { revision: 'rev789', served } }),
  });
  expect(await revertCorrection(revertInput, ports)).toMatchObject({
    state: 'revert_accepted',
    decidedAt: new Date(T0).toISOString(),
  });
  now = T0 + 181_000;
  served = true;
  expect(await revertCorrection(revertInput, ports)).toMatchObject({
    state: 'reverted',
    decidedAt: new Date(T0).toISOString(),
    observedAt: new Date(now).toISOString(),
    intervalMs: 181_000,
  });
});

it('a replacement decoy does not establish that the target word landed', async () => {
  // The page before the change already held the other copy: the place is calibrated on it.
  const before = page('Parking beside the clinic. We walk alongside you.');
  const accepted = await publishCorrection(approvedJob(), publishPorts([], { capture: before }));
  if (accepted.state !== 'accepted') throw new Error(`not accepted: ${accepted.state}`);
  const observe = (text: string) =>
    observeLanded(accepted, TARGET, {
      raiseTask: async () => {},
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: PUBLISHED.revision, served: true } }),
      capture: page(text),
    });
  // The target still holds the original word; the replacement stands only in other copy.
  expect((await observe('Parking beside the clinic. We walk alongside you.')).state).toBe(
    'accepted',
  );
  expect((await observe('Parking beside the clinic. We walk beside you.')).state).toBe('live');
});

it('an unrelated replacement word does not prevent observing a correct revert', async () => {
  // The target holds the original word again; the replacement stands only in other copy.
  const reverted = page('We walk alongside you. Parking beside the clinic.');
  const outcome = await revertCorrection(revertInput, revertPorts([], { capture: reverted }));
  expect(outcome.state).toBe('reverted');
  const notYet = page('We walk beside you. Parking beside the clinic.');
  expect((await revertCorrection(revertInput, revertPorts([], { capture: notYet }))).state).toBe(
    'revert_accepted',
  );
});

// The seam read absent, then an earlier attempt landed late, so the resend meets "already done".
const raced = <T>(value: T, proof: string) => {
  let landed = false;
  return {
    send: () => {
      landed = true;
      return Promise.resolve({ kind: 'refused' as const, code: 'PROVIDER_REFUSED', proof });
    },
    readBack: () =>
      Promise.resolve(landed ? { state: 'landed' as const, value } : { state: 'absent' as const }),
  };
};

it('a resend refused because a late landing beat it records landed, not failed', async () => {
  const revert = raced(REVERTED, 'sha_mismatch');
  const reverted = await revertCorrection(
    revertInput,
    revertPorts([], { revert: revert.send, readBack: revert.readBack }),
  );
  const publish = raced(PUBLISHED, 'sha_mismatch');
  const published = await publishCorrection(
    approvedJob(),
    publishPorts([], { publish: publish.send, readBack: publish.readBack }),
  );
  expect({ reverted: reverted.state, published: published.state }).toEqual({
    reverted: 'reverted',
    published: 'accepted',
  });
});
