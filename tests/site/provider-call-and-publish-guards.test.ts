// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/consistent-function-scoping -- the proof bodies are kept as written */
import { expect, it, vi } from 'vitest';
import {
  callConnector,
  contentDigest,
  connectorRelease,
  observeLanded,
  publishCorrection,
  revertCorrection,
  siteOperation,
  versionDigestOf,
  type PublishJob,
  type ConnectorResult,
  type PublishPorts,
  type TransportAnswer,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const target = { path: 'src/pages/about.astro', word: 'friendly', replacement: 'welcoming' };
const before = '<p>We are a friendly studio.</p>\n';
const after = '<p>We are a welcoming studio.</p>\n';
const published = {
  revision: 'revision-approved',
  deploymentId: 'deployment-approved',
  liveUrl: 'https://agency.example/about/',
};

function job(): PublishJob {
  const pin = {
    target,
    change: { files: [{ path: target.path, before, after }] },
    preImageDigest: contentDigest(before),
    baseRevision: 'revision-before',
    pageUrl: published.liveUrl,
    seam: 'request-17',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-approved',
    version: { versionId: 'version-approved', digest },
    decision: {
      decisionId: 'decision-approved',
      decision: 'approve',
      versionId: 'version-approved',
      versionDigest: digest,
    },
    seam: 'request-17',
  };
}

function ports(overrides: Partial<PublishPorts> = {}): PublishPorts {
  let attempted = false;
  const send = overrides.publish ?? (async () => ({ kind: 'ok' as const, value: published }));
  return {
    readBack: async () => ({ state: attempted ? 'unknown' : 'absent' }),
    readSource: async () => ({
      kind: 'ok',
      value: { content: before, revision: 'revision-before' },
    }),
    cancellation: async () => 'none',
    raiseTask: async () => {},
    ...overrides,
    publish: async (input) => {
      attempted = true;
      return await send(input);
    },
  };
}

function json(value: unknown): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

it('the provider deadline also bounds DNS preparation', async () => {
  vi.useFakeTimers();
  let finishDns: (addresses: readonly string[]) => void = () => {};
  const dns = new Promise<readonly string[]>((resolve) => {
    finishDns = resolve;
  });
  const registered = siteOperation('site.source.read');
  const connector = { ...registered.connector, timeoutMs: 20 };
  const registration = {
    connector,
    declaration: { ...registered.declaration, connector_release: connectorRelease(connector) },
  };
  let settled: ConnectorResult | undefined;
  let sent = 0;
  const pending = callConnector(
    registration,
    { repository: 'agency/site', path: target.path, ref: 'revision-before' },
    {
      resolve: () => dns,
      credential: async () => 'synthetic-source-key',
      record: () => {},
      transport: async () => {
        sent += 1;
        return json({ sha: 'blob-before', content: 'encoded-content', encoding: 'base64' });
      },
    },
  ).then((result) => {
    settled = result;
    return result;
  });
  try {
    await vi.advanceTimersByTimeAsync(21);
    expect({ settled, sent }).toMatchObject({
      settled: { kind: 'refused', code: 'PROVIDER_TIMEOUT' },
      sent: 0,
    });
  } finally {
    finishDns(['140.82.112.6']);
    await pending;
    vi.useRealTimers();
  }
});

it('source reads send the declared pinned ref', async () => {
  const sent: TransportRequest[] = [];
  const result = await callConnector(
    siteOperation('site.source.read'),
    { repository: 'agency/site', path: target.path, ref: 'approved/branch' },
    {
      resolve: async () => ['140.82.112.6'],
      credential: async () => 'synthetic-source-key',
      record: () => {},
      transport: async (request) => {
        sent.push(request);
        return json({ sha: 'blob-before', content: 'encoded-content', encoding: 'base64' });
      },
    },
  );
  expect(result.kind).toBe('ok');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.searchParams.get('ref')).toBe('approved/branch');
});

it('a credential echoed in a declared string field cannot escape', async () => {
  const canary = 'Sol-synthetic-secret-provider-echo';
  const recorded: string[] = [];
  const result = await callConnector(
    siteOperation('site.publish'),
    { repository: 'agency/site', number: '17', sha: 'revision-approved' },
    {
      resolve: async () => ['140.82.112.6'],
      credential: async () => canary,
      record: (code) => {
        recorded.push(code);
      },
      transport: async (request) => {
        expect(request.headers['authorization']).toBe(`Bearer ${canary}`);
        return json({ merged: true, sha: canary });
      },
    },
  );
  expect(JSON.stringify({ result, recorded })).not.toContain(canary);
});

it('cancellation during the drift read prevents dispatch', async () => {
  let cancelled = false;
  let sent = 0;
  const outcome = await publishCorrection(
    job(),
    ports({
      cancellation: async () => (cancelled ? 'requested' : 'none'),
      readSource: async () => {
        cancelled = true;
        return { kind: 'ok', value: { content: before, revision: 'revision-before' } };
      },
      publish: async () => {
        sent += 1;
        return { kind: 'ok', value: published };
      },
    }),
  );
  expect({ sent, outcome }).toEqual({ sent: 0, outcome: { state: 'refused', code: 'CANCELLED' } });
});

it('approval for one publish reference cannot authorise another', async () => {
  const approved = job();
  const substituted = { ...approved, seam: 'request-unapproved' };
  // The effect reference changes while the pinned file bytes still match.
  const sent: string[] = [];
  const outcome = await publishCorrection(
    substituted,
    ports({
      publish: async (input) => {
        sent.push(input.seam);
        return { kind: 'ok', value: published };
      },
    }),
  );
  expect({ sent, outcome }).toEqual({
    sent: [],
    outcome: { state: 'refused', code: 'PROPOSAL_SUPERSEDED' },
  });
});

it('an unknown publish is not dispatched blind on retry', async () => {
  const sent: unknown[] = [];
  const p = ports({
    publish: async (input) => {
      sent.push(input);
      return { kind: 'unknown', code: 'PROVIDER_TIMEOUT' };
    },
  });
  const approved = job();
  expect((await publishCorrection(approved, p)).state).toBe('unknown');
  expect((await publishCorrection(approved, p)).state).toBe('unknown');
  expect(sent).toHaveLength(1);
});

it('an unknown revert is not dispatched blind on retry', async () => {
  const sent: unknown[] = [];
  const p = {
    now: () => Date.parse('2026-10-04T00:00:00Z'),
    readBack: async () => ({
      state: sent.length === 0 ? ('absent' as const) : ('unknown' as const),
    }),
    revert: async (input: { seam: string; dispatchToken: string }) => {
      sent.push(input);
      return { kind: 'unknown' as const, code: 'PROVIDER_TIMEOUT' };
    },
    readDeployment: async () => ({
      kind: 'ok' as const,
      value: { revision: 'reverted', served: true },
    }),
    capture: async () => ({ ok: true as const, value: { text: 'We are a friendly studio.' } }),
  };
  const input = {
    publishedRevision: published.revision,
    target,
    seam: 'revert-request',
    change: job().change,
    decidedAt: Date.parse('2026-10-04T00:00:00Z'),
  };
  expect((await revertCorrection(input, p)).state).toBe('unknown');
  expect((await revertCorrection(input, p)).state).toBe('unknown');
  expect(sent).toHaveLength(1);
});

it('a pending revert keeps the original decision time until observation', async () => {
  const decided = Date.parse('2026-10-04T00:00:00Z');
  let now = decided;
  let served = false;
  const p = {
    now: () => now,
    readBack: async () => ({ state: 'absent' as const }),
    revert: async () => ({
      kind: 'ok' as const,
      value: { revision: 'reverted', deploymentId: 'revert-deployment' },
    }),
    readDeployment: async () => {
      now += 1_000;
      return { kind: 'ok' as const, value: { revision: 'reverted', served } };
    },
    capture: async () => ({ ok: true as const, value: { text: 'We are a friendly studio.' } }),
  };
  const input = {
    publishedRevision: published.revision,
    target,
    seam: 'revert-request',
    change: job().change,
    decidedAt: Date.parse('2026-10-04T00:00:00Z'),
  };
  const pending = await revertCorrection(input, p);
  expect(pending).toMatchObject({
    state: 'revert_accepted',
    decidedAt: new Date(decided).toISOString(),
  });
  now = decided + 180_000;
  served = true;
  expect(await revertCorrection(input, p)).toMatchObject({
    state: 'reverted',
    decidedAt: new Date(decided).toISOString(),
    intervalMs: 181_000,
  });
});

it('a replacement decoy does not establish that the target word landed', async () => {
  const accepted = {
    state: 'accepted' as const,
    ...published,
    dispatchToken: 'publish-token',
    occurrence: { left: 'We are a ', right: ' studio.' },
  };
  const result = await observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({
      ok: true,
      value: { text: 'Welcome to our welcoming team. We are a friendly studio.' },
    }),
  });
  expect(result.state).toBe('accepted');
});

it('an unrelated replacement word does not prevent observing a correct revert', async () => {
  const outcome = await revertCorrection(
    {
      publishedRevision: published.revision,
      target,
      seam: 'revert-request',
      change: job().change,
      decidedAt: Date.parse('2026-10-04T00:00:00Z'),
    },
    {
      now: () => Date.parse('2026-10-04T00:00:00Z'),
      readBack: async () => ({ state: 'absent' as const }),
      revert: async () => ({
        kind: 'ok',
        value: { revision: 'reverted', deploymentId: 'revert-deployment' },
      }),
      readDeployment: async () => ({ kind: 'ok', value: { revision: 'reverted', served: true } }),
      capture: async () => ({
        ok: true,
        value: { text: 'Welcome to our welcoming team. We are a friendly studio.' },
      }),
    },
  );
  expect(outcome.state).toBe('reverted');
});
