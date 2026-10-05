// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the proof bodies are kept as written */
import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  contentDigest,
  observeLanded,
  publishCorrection,
  revertCorrection,
  versionDigestOf,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';
import { calibrated } from '../../packages/core-connectors/src/site/reconcile.ts';

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
const before = '<p>We walk alongside you.</p>\n';
const after = '<p>We walk beside you.</p>\n';
const published = {
  revision: 'approved-revision',
  deploymentId: 'deployment-1',
  liveUrl: 'https://agency.example/about/',
};
const reverted = { revision: 'revert-revision', deploymentId: 'deployment-2' };
const decidedAt = Date.parse('2026-10-04T00:00:00Z');

function job(source = before): PublishJob {
  const pin = {
    target,
    change: {
      files: [{ path: target.path, before: source, after: source.replace('alongside', 'beside') }],
    },
    preImageDigest: contentDigest(source),
    baseRevision: 'base-revision',
    pageUrl: published.liveUrl,
    seam: 'request-17',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-1',
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
  };
}

/** Visible text of the served page, as the fenced capture reads it. */
function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

function ports(overrides: Partial<PublishPorts> = {}, source = before): PublishPorts {
  return {
    readSource: async () => ({ kind: 'ok', value: { content: source, revision: 'base-revision' } }),
    readBack: async () => ({ state: 'absent' }),
    publish: async () => ({ kind: 'ok', value: published }),
    cancellation: async () => 'none',
    raiseTask: async () => {},
    capture: async () => ({ ok: true, value: { text: seen(source) } }),
    ...overrides,
  };
}

it('a landed publish reconciles after its own effect changes the source', async () => {
  let landed = false;
  let sends = 0;
  let readbacks = 0;
  const p = ports({
    readSource: async () => ({
      kind: 'ok',
      value: {
        content: landed ? after : before,
        revision: landed ? published.revision : 'base-revision',
      },
    }),
    readBack: async () => {
      readbacks += 1;
      return landed ? { state: 'landed', value: published } : { state: 'absent' };
    },
    publish: async () => {
      sends += 1;
      landed = true;
      return { kind: 'unknown', code: 'PROVIDER_CONNECTION_LOST' };
    },
  });
  expect((await publishCorrection(job(), p)).state).toBe('unknown');
  expect(await publishCorrection(job(), p)).toMatchObject({ state: 'accepted', ...published });
  expect({ sends, readbacks }).toEqual({ sends: 1, readbacks: 2 });
});

it('concurrent absent reads cannot dispatch the same publish twice', async () => {
  let reads = 0;
  let sends = 0;
  const p = ports({
    readBack: async () => {
      reads += 1;
      await Promise.resolve();
      return sends === 0 ? { state: 'absent' } : { state: 'landed', value: published };
    },
    publish: async () => {
      sends += 1;
      return { kind: 'ok', value: published };
    },
  });
  await Promise.all([publishCorrection(job(), p), publishCorrection(job(), p)]);
  expect(sends).toBe(1);
  expect(reads).toBeGreaterThan(0);
});

it('concurrent absent reads cannot dispatch the same revert twice', async () => {
  let reads = 0;
  let sends = 0;
  const input = {
    publishedRevision: published.revision,
    target,
    occurrence: calibrated(job().change, target, seen(before)),
    seam: 'revert-1',
    decidedAt,
  };
  const p: Parameters<typeof revertCorrection>[1] = {
    now: () => decidedAt + 1000,
    readBack: async () => {
      reads += 1;
      await Promise.resolve();
      return sends === 0 ? { state: 'absent' } : { state: 'landed', value: reverted };
    },
    revert: async () => {
      sends += 1;
      return { kind: 'ok', value: reverted };
    },
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: reverted.revision, served: false },
    }),
    capture: async () => ({ ok: false }),
  };
  await Promise.all([revertCorrection(input, p), revertCorrection(input, p)]);
  expect(sends).toBe(1);
  expect(reads).toBeGreaterThan(0);
});

it('an isolated text node does not make unrelated words block publish or revert observation', async () => {
  const isolated = '<p>We walk <strong>alongside</strong> you.</p>\n';
  const approved = job(isolated);
  const accepted = await publishCorrection(approved, ports({}, isolated));
  if (accepted.state !== 'accepted') throw new Error('fixture was not accepted');
  const live = await observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({
      ok: true,
      value: {
        text: 'We walk beside you. Alongside our office is a park. We work alongside friends.',
      },
    }),
  });
  const restored = await revertCorrection(
    {
      publishedRevision: published.revision,
      target,
      occurrence: accepted.occurrence,
      seam: 'revert-1',
      decidedAt,
    },
    {
      now: () => decidedAt + 1000,
      readBack: async () => ({ state: 'absent' }),
      revert: async () => ({ kind: 'ok', value: reverted }),
      readDeployment: async () => ({
        kind: 'ok',
        value: { revision: reverted.revision, served: true },
      }),
      capture: async () => ({
        ok: true,
        value: { text: 'We walk alongside you. The park is beside our office.' },
      }),
    },
  );
  expect({ publish: live.state, revert: restored.state }).toEqual({
    publish: 'live',
    revert: 'reverted',
  });
});

it('observation compares rendered entity text rather than source spellings', async () => {
  const source = '<p>We &amp; our friends walk alongside you.</p>\n';
  const accepted = await publishCorrection(job(source), ports({}, source));
  if (accepted.state !== 'accepted') throw new Error('fixture was not accepted');
  const observed = await observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({ ok: true, value: { text: 'We & our friends walk beside you.' } }),
  });
  expect(observed.state).toBe('live');
});

it('an unchanged duplicate sentence does not block the approved occurrence becoming live', async () => {
  const source = before + before;
  const accepted = await publishCorrection(job(source), ports({}, source));
  if (accepted.state !== 'accepted') throw new Error('fixture was not accepted');
  const observed = await observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({
      ok: true,
      value: { text: 'We walk beside you. We walk alongside you.' },
    }),
  });
  expect(observed.state).toBe('live');
});
