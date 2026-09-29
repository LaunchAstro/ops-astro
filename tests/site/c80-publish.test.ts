// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the reviewed executable that performs the one real effect. Each case
// is the release decision's section 8, run against doubles of the source
// control and hosting connectors on a throwaway branch and page: nothing here
// reaches a live system.

import { describe, expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  contentDigest,
  dispatchToken,
  observeLanded,
  publishCorrection,
  revertCorrection,
  type ConnectorResult,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
  type Transport,
  type TransportRequest,
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
  const versionDigest = contentDigest({ target: TARGET, change });
  return {
    correctionId: 'correction-1',
    target: TARGET,
    change,
    preImageDigest: contentDigest(BEFORE),
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
    readSource: async () => ({ kind: 'ok', value: { content: BEFORE, revision: 'abc123' } }),
    publish: async () => {
      calls.published += 1;
      return {
        kind: 'ok',
        value: {
          revision: 'def456',
          deploymentId: 'dpl_1',
          liveUrl: 'https://www.example.com/throwaway',
        },
      };
    },
    cancellation: async () => 'none',
    raiseTask: async (reason) => {
      calls.raised.push(reason);
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
      readSource: async () => ({
        kind: 'ok',
        value: { content: '<p>We walk alongside you!</p>\n', revision: 'zzz999' },
      }),
    });
    const outcome = await publishCorrection(job(), p);
    expect(outcome).toMatchObject({ state: 'refused', code: 'CONTENT_DRIFTED', waitsOn: 'person' });
    expect(p.calls.published).toBe(0);
  });

  it('refuses when the drift read itself does not answer, rather than publishing unchecked', async () => {
    const p = ports({ readSource: async () => ({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' }) });
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
        publish: async () => ({ kind: 'unknown', code }),
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
      publish: async () => ({ kind: 'refused', code: 'PROVIDER_REFUSED', proof: 'merge_conflict' }),
    });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'failed',
      proof: 'merge_conflict',
    });
    const q = ports({
      publish: async () => ({ kind: 'refused', code: 'PROVIDER_REFUSED', proof: 'something_else' }),
    });
    expect(await publishCorrection(job(), q)).toMatchObject({ state: 'unknown' });
  });
});

describe('C80 late cancellation', () => {
  it('a cancellation before dispatch cancels and publishes nothing', async () => {
    const p = ports({ cancellation: async () => 'requested' });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'refused',
      code: 'CANCELLED',
    });
    expect(p.calls.published).toBe(0);
  });

  it('a cancellation arriving after dispatch is reported as uncertain, never as a clean cancellation', async () => {
    let dispatched = false;
    const p = ports({
      cancellation: async () => (dispatched ? 'requested' : 'none'),
      publish: async () => {
        dispatched = true;
        return { kind: 'unknown', code: 'PROVIDER_CONNECTION_LOST' };
      },
    });
    expect(await publishCorrection(job(), p)).toMatchObject({
      state: 'unknown',
      code: 'CANCELLED_AFTER_DISPATCH',
      reference: 'request-17',
    });
  });
});

const served = async () => ({ kind: 'ok' as const, value: { revision: 'def456', served: true } });
const shows = async () => ({ ok: true as const, value: { text: 'We walk beside you.' } });
const notServed = async () => ({
  kind: 'ok' as const,
  value: { revision: 'def456', served: false },
});
const otherRevision = async () => ({
  kind: 'ok' as const,
  value: { revision: 'old', served: true },
});
const oldWord = async () => ({ ok: true as const, value: { text: 'We walk alongside you.' } });

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

describe('C80 revert timed', () => {
  it('publishes the revert forward, observes it served, and records the interval from the decision to revert', async () => {
    const times = [Date.parse('2026-09-29T10:00:00Z'), Date.parse('2026-09-29T10:03:30Z')];
    const outcome = await revertCorrection(
      { publishedRevision: 'def456', target: TARGET, seam: 'revert-of-def456' },
      {
        now: () => times.shift() ?? Number.NaN,
        revert: async () => ({ kind: 'ok', value: { revision: 'rev789', deploymentId: 'dpl_2' } }),
        readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev789', served: true } }),
        capture: async () => ({ ok: true, value: { text: 'We walk alongside you.' } }),
      },
    );
    expect(outcome).toEqual({
      state: 'reverted',
      revision: 'rev789',
      deploymentId: 'dpl_2',
      decidedAt: '2026-09-29T10:00:00.000Z',
      observedAt: '2026-09-29T10:03:30.000Z',
      intervalMs: 210_000,
    });
  });

  it('records no interval until the original word is observed live', async () => {
    const outcome = await revertCorrection(
      { publishedRevision: 'def456', target: TARGET, seam: 'revert-of-def456' },
      {
        now: () => Date.parse('2026-09-29T10:00:00Z'),
        revert: async () => ({ kind: 'ok', value: { revision: 'rev789', deploymentId: 'dpl_2' } }),
        readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev789', served: true } }),
        capture: async () => ({ ok: true, value: { text: 'We walk beside you.' } }),
      },
    );
    expect(outcome).toMatchObject({ state: 'revert_accepted' });
    expect(outcome).not.toHaveProperty('intervalMs');
  });
});

const publishRegistration = SITE_OPERATIONS.find(
  (entry) => entry.declaration.operation_name === 'site.publish',
)!;

function httpOf(answer: Awaited<ReturnType<Transport>>): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  return Object.assign(
    async (request: TransportRequest) => {
      seen.push(request);
      return answer;
    },
    { seen },
  );
}

const json = (body: unknown, status = 200) => ({
  kind: 'answer' as const,
  status,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const deps = (transport: Transport, recorded: string[] = []) => ({
  transport,
  resolve: async () => ['140.82.112.6'],
  credential: async () => 'canary-token-C80-never-shown',
  record: (code: string) => recorded.push(code),
});

describe('C80 hostile provider (source control and hosting paths)', () => {
  const params = { repository: 'site', number: '17' };

  it('returns only the declared response fields from a well-formed answer', async () => {
    const transport = httpOf(json({ merged: true, sha: 'def456', message: 'ok', token: 'leak' }));
    const result = await callConnector(publishRegistration, params, deps(transport));
    expect(result).toEqual({ kind: 'ok', value: { merged: true, sha: 'def456' } });
    expect(transport.seen[0]?.url.hostname).toBe(publishRegistration.connector.host);
  });

  it.each([
    [
      'a redirect',
      {
        kind: 'answer',
        status: 307,
        headers: { location: 'https://evil.example.net/' },
        body: new Uint8Array(),
      },
      'PROVIDER_REDIRECT_REFUSED',
    ],
    ['a timeout', { kind: 'timeout' }, 'PROVIDER_TIMEOUT'],
    ['an oversized body', { kind: 'oversized' }, 'PROVIDER_RESPONSE_OVERSIZED'],
    [
      'a malformed body',
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"merged":'),
      },
      'PROVIDER_RESPONSE_MALFORMED',
    ],
    ['a schema mismatch', json({ merged: 'yes', sha: 1 }), 'PROVIDER_RESPONSE_SCHEMA'],
    [
      'a wrong content type',
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: new TextEncoder().encode('<p>'),
      },
      'PROVIDER_RESPONSE_MALFORMED',
    ],
  ] as const)(
    'a write meeting %s is unknown, recorded, never success',
    async (_name, answer, code) => {
      const recorded: string[] = [];
      const result = await callConnector(
        publishRegistration,
        params,
        deps(httpOf(answer as never), recorded),
      );
      expect(result).toEqual({ kind: 'unknown', code });
      expect(recorded).toEqual([code]);
    },
  );

  it('refuses an unlisted destination before any connection', async () => {
    const transport = httpOf(json({}));
    const moved = {
      ...publishRegistration,
      connector: { ...publishRegistration.connector, host: 'api.evil.example.net' },
    };
    expect(await callConnector(moved, params, deps(transport))).toEqual({
      kind: 'refused',
      code: 'DESTINATION_NOT_LISTED',
    });
    expect(transport.seen).toHaveLength(0);
  });

  it('never sends a credential to a host other than the one that credential belongs to', async () => {
    const transport = httpOf(json({}));
    const crossed = {
      ...publishRegistration,
      connector: { ...publishRegistration.connector, host: 'api.vercel.com' },
    };
    expect(await callConnector(crossed, params, deps(transport))).toEqual({
      kind: 'refused',
      code: 'CREDENTIAL_HOST_MISMATCH',
    });
    expect(transport.seen).toHaveLength(0);
  });

  it('refuses a provider address on a private network before any connection', async () => {
    const transport = httpOf(json({}));
    const result = await callConnector(publishRegistration, params, {
      ...deps(transport),
      resolve: async () => ['10.0.0.1'],
    });
    expect(result).toEqual({ kind: 'refused', code: 'DESTINATION_ADDRESS_DENIED' });
    expect(transport.seen).toHaveLength(0);
  });

  it('refuses a parameter the operation does not declare, and one that would climb the path', async () => {
    const transport = httpOf(json({}));
    expect(
      await callConnector(publishRegistration, { ...params, extra: 'x' }, deps(transport)),
    ).toEqual({ kind: 'refused', code: 'PARAMETER_NOT_DECLARED' });
    expect(
      await callConnector(
        publishRegistration,
        { repository: '../../orgs', number: '17' },
        deps(transport),
      ),
    ).toEqual({ kind: 'refused', code: 'PARAMETER_INVALID' });
    expect(transport.seen).toHaveLength(0);
  });

  it('never lets the credential reach a result, a record or an error', async () => {
    const recorded: string[] = [];
    const answers = [
      json({ message: 'canary-token-C80-never-shown' }, 401),
      { kind: 'failed' } as const,
      json({ merged: 'canary-token-C80-never-shown' }),
    ];
    const results: ConnectorResult[] = await Promise.all(
      answers.map((answer) =>
        callConnector(publishRegistration, params, deps(httpOf(answer), recorded)),
      ),
    );
    const shown = JSON.stringify({ results, recorded });
    expect(shown).not.toContain('canary-token-C80-never-shown');
  });
});
