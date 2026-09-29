// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the reviewed executable that performs the one real effect. Each case
// is the release decision's section 8, run against doubles of the source
// control and hosting connectors on a throwaway branch and page: nothing here
// reaches a live system.

import { describe, expect, it } from 'vitest';
import {
  contentDigest,
  dispatchToken,
  observeLanded,
  publishCorrection,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/throwaway.astro',
  word: 'alongside',
  replacement: 'beside',
};
const BEFORE = '<p>We walk alongside you.</p>\n';
const AFTER = '<p>We walk beside you.</p>\n';

function job(overrides: Partial<PublishJob> = {}): PublishJob {
  const change = { files: [{ path: TARGET.path, before: BEFORE, after: AFTER }] };
  const pinned = {
    target: TARGET,
    change,
    preImageDigest: contentDigest(BEFORE),
    baseRevision: 'abc123',
    pageUrl: 'https://agency.example/throwaway/',
  };
  const versionDigest = versionDigestOf(pinned);
  return {
    correctionId: 'correction-1',
    ...pinned,
    version: { versionId: 'version-2', digest: versionDigest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-2',
      versionDigest,
    },
    seam: 'request-17',
    ...overrides,
  };
}

interface Calls {
  published: number;
  raised: string[];
}

function ports(overrides: Partial<PublishPorts> = {}): PublishPorts & { calls: Calls } {
  const calls: Calls = { published: 0, raised: [] };
  return {
    calls,
    readSource: () =>
      Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'abc123' } }),
    publish: () => {
      calls.published += 1;
      return Promise.resolve({
        kind: 'ok',
        value: {
          revision: 'def456',
          deploymentId: 'dpl_1',
          liveUrl: 'https://www.example.com/throwaway',
        },
      });
    },
    cancellation: () => Promise.resolve('none' as const),
    raiseTask: (reason) => {
      calls.raised.push(reason);
      return Promise.resolve();
    },
    ...overrides,
  } as PublishPorts & { calls: Calls };
}

describe('C80 unapproved publish refused', () => {
  it('publishes nothing without an approving decision on the exact version', async () => {
    const decisions = [
      undefined,
      {
        decisionId: 'd',
        decision: 'reject' as const,
        versionId: 'version-2',
        versionDigest: job().version.digest,
      },
      {
        decisionId: 'd',
        decision: 'request_changes' as const,
        versionId: 'version-2',
        versionDigest: job().version.digest,
      },
    ];
    const runs = decisions.map(async (decision) => {
      const p = ports();
      const outcome = await publishCorrection(job({ decision }), p);
      return { outcome, published: p.calls.published };
    });
    for (const run of await Promise.all(runs)) {
      expect(run.outcome).toMatchObject({ state: 'refused', code: 'APPROVAL_MISSING' });
      expect(run.published).toBe(0);
    }
  });

  it('publishes nothing when the approved digest is not the digest of the change being published', async () => {
    const tampered = job();
    const p = ports();
    const outcome = await publishCorrection(
      {
        ...tampered,
        change: {
          files: [{ path: TARGET.path, before: BEFORE, after: '<p>We walk near you.</p>\n' }],
        },
      },
      p,
    );
    expect(outcome).toMatchObject({ state: 'refused', code: 'PROPOSAL_SUPERSEDED' });
    expect(p.calls.published).toBe(0);
  });
});

describe('C80 stale decision', () => {
  it('refuses PROPOSAL_SUPERSEDED for a decision bound to a superseded version, and publishes nothing', async () => {
    const stale = job();
    const p = ports();
    const outcome = await publishCorrection(
      { ...stale, decision: { ...stale.decision!, versionId: 'version-1' } },
      p,
    );
    expect(outcome).toMatchObject({ state: 'refused', code: 'PROPOSAL_SUPERSEDED' });
    expect(p.calls.published).toBe(0);
  });
});

describe('C80 drift refused', () => {
  it('refuses CONTENT_DRIFTED when the file moved after approval, waits on a person, never overwrites', async () => {
    const p = ports({
      readSource: () =>
        Promise.resolve({
          kind: 'ok',
          value: { content: '<p>We walk alongside you!</p>\n', revision: 'zzz999' },
        }),
    });
    const outcome = await publishCorrection(job(), p);
    expect(outcome).toMatchObject({ state: 'refused', code: 'CONTENT_DRIFTED', waitsOn: 'person' });
    expect(p.calls.published).toBe(0);
  });

  it('refuses when the drift read itself does not answer, rather than publishing unchecked', async () => {
    const p = ports({
      readSource: () => Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' }),
    });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'refused',
      code: 'CONTENT_DRIFT_UNCHECKED',
    });
    expect(p.calls.published).toBe(0);
  });
});

describe('C80 unknown publish outcome', () => {
  it.each(['PROVIDER_TIMEOUT', 'PROVIDER_RESPONSE_MALFORMED', 'PROVIDER_CONNECTION_LOST'])(
    'leaves %s as unknown with its reference, raises a task, and never converts it',
    async (code) => {
      const p = ports({
        publish: () => Promise.resolve({ kind: 'unknown', code }),
      });
      const outcome = await publishCorrection(job(), p);
      expect(outcome).toEqual({
        state: 'unknown',
        code,
        reference: 'request-17',
        dispatchToken: dispatchToken('site.publish', job().version.digest),
      });
      expect(p.calls.raised).toEqual([code]);
    },
  );

  it('keeps the same dispatch token for the same approved version, so a retry is the same intended effect', () => {
    expect(dispatchToken('site.publish', 'sha256:a')).toBe(
      dispatchToken('site.publish', 'sha256:a'),
    );
    expect(dispatchToken('site.publish', 'sha256:a')).not.toBe(
      dispatchToken('site.publish', 'sha256:b'),
    );
  });

  it('settles failed only on a declared nothing-happened proof', async () => {
    const p = ports({
      publish: () =>
        Promise.resolve({ kind: 'refused', code: 'PROVIDER_REFUSED', proof: 'merge_conflict' }),
    });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'failed',
      proof: 'merge_conflict',
    });
    const q = ports({
      publish: () =>
        Promise.resolve({ kind: 'refused', code: 'PROVIDER_REFUSED', proof: 'something_else' }),
    });
    expect(await publishCorrection(job(), q)).toMatchObject({ state: 'unknown' });
  });
});

describe('C80 late cancellation', () => {
  it('a cancellation before dispatch cancels and publishes nothing', async () => {
    const p = ports({ cancellation: () => Promise.resolve('requested' as const) });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'refused',
      code: 'CANCELLED',
    });
    expect(p.calls.published).toBe(0);
  });

  it('a cancellation arriving after dispatch is reported as uncertain, never as a clean cancellation', async () => {
    let dispatched = false;
    const p = ports({
      cancellation: () => Promise.resolve(dispatched ? ('requested' as const) : ('none' as const)),
      publish: () => {
        dispatched = true;
        return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_CONNECTION_LOST' });
      },
    });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'unknown',
      code: 'CANCELLED_AFTER_DISPATCH',
      reference: 'request-17',
    });
  });
});

const served = () =>
  Promise.resolve({ kind: 'ok' as const, value: { revision: 'def456', served: true } });
const shows = () => Promise.resolve({ ok: true as const, value: { text: 'We walk beside you.' } });
const notServed = () =>
  Promise.resolve({
    kind: 'ok' as const,
    value: { revision: 'def456', served: false },
  });
const otherRevision = () =>
  Promise.resolve({
    kind: 'ok' as const,
    value: { revision: 'old', served: true },
  });
const oldWord = () =>
  Promise.resolve({ ok: true as const, value: { text: 'We walk alongside you.' } });

describe('C80 accepted not landed', () => {
  it('a successful publish response establishes accepted only', async () => {
    const outcome = await publishCorrection(job(), ports());
    expect(outcome).toMatchObject({ state: 'accepted', revision: 'def456', deploymentId: 'dpl_1' });
    expect(outcome.state).not.toBe('live');
  });

  const accepted = {
    state: 'accepted' as const,
    revision: 'def456',
    deploymentId: 'dpl_1',
    liveUrl: 'https://www.example.com/throwaway',
    dispatchToken: 'x',
  };

  it('is live only when the deployment is served for that revision and the fenced capture shows the new word', async () => {
    expect(
      await observeLanded(accepted, TARGET, { readDeployment: served, capture: shows }),
    ).toMatchObject({
      state: 'live',
    });
    expect(
      await observeLanded(accepted, TARGET, { readDeployment: notServed, capture: shows }),
    ).toMatchObject({
      state: 'accepted',
    });
    expect(
      await observeLanded(accepted, TARGET, { readDeployment: otherRevision, capture: shows }),
    ).toMatchObject({ state: 'accepted' });
    expect(
      await observeLanded(accepted, TARGET, { readDeployment: served, capture: oldWord }),
    ).toMatchObject({
      state: 'accepted',
    });
  });
});
