// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// The live check's world: one catalogued page and one beside it, two approved
// one-word corrections, ports that answer the served page with the address
// its capture ended on, and a task port that keeps one task per reason and key.

import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  contentDigest,
  observeLanded,
  revertCorrection,
  versionDigestOf,
  type Accepted,
  type CorrectionTarget,
  type Occurrence,
  type PublishJob,
  type PublishPorts,
  type RevertOutcome,
} from '../../packages/core-connectors/src/index.ts';

export const PAGE = 'https://agency.example/contact/';
export const OTHER = 'https://agency.example/other/';
export const published: {
  readonly revision: string;
  readonly deploymentId: string;
  readonly liveUrl: string;
} = { revision: 'rev-1', deploymentId: 'dep-1', liveUrl: PAGE };
export const contact: CorrectionTarget = {
  path: 'src/pages/contact.astro',
  word: 'Contcat',
  replacement: 'Contact',
};
export const about: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

export function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

/** The approved occurrence is the source's first copy of the word unless `after` says otherwise. */
export function job(
  target: CorrectionTarget,
  before: string,
  after: string = before.replace(target.word, target.replacement),
): PublishJob {
  const pin = {
    target,
    change: { files: [{ path: target.path, before, after }] },
    preImageDigest: contentDigest(before),
    baseRevision: 'base',
    pageUrl: PAGE,
    seam: 'request-982',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-982',
    version: { versionId: 'v1', digest },
    decision: { decisionId: 'd1', decision: 'approve', versionId: 'v1', versionDigest: digest },
  };
}

/** Every call, and the tasks a port that keeps one per reason and key holds. */
export interface Tasks {
  readonly calls: string[];
  readonly raised: Set<string>;
  readonly raiseTask: PublishPorts['raiseTask'];
}

/** A task port that keeps one task per reason and key, as the contract asks. */
export function tasks(): Tasks {
  const calls: string[] = [];
  const raised = new Set<string>();
  const raiseTask = async (reason: string, key?: string) => {
    calls.push(reason);
    // A call without a key could never be told from another effect's: it is its own task.
    raised.add(
      typeof key === 'string' && key !== '' ? `${reason} ${key}` : `${reason} #${calls.length}`,
    );
  };
  return { calls, raised, raiseTask };
}

export function publishPorts(
  source: string,
  pre: { html: string; url: string },
  overrides: Partial<PublishPorts> = {},
): PublishPorts {
  return {
    readSource: async () => ({ kind: 'ok', value: { content: source, revision: 'base' } }),
    readBack: async () => ({ state: 'absent' }),
    publish: async () => ({ kind: 'ok', value: published }),
    cancellation: async () => 'none',
    raiseTask: async () => {},
    capture: async () => ({ ok: true, value: { text: seen(pre.html), url: pre.url } }),
    ...overrides,
  };
}

export function observe(
  accepted: Accepted,
  target: CorrectionTarget,
  html: string,
  url: string = PAGE,
  raiseTask: PublishPorts['raiseTask'] = async () => {},
): ReturnType<typeof observeLanded> {
  return observeLanded(accepted, target, {
    readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev-1', served: true } }),
    capture: async () => ({ ok: true, value: { text: seen(html), url } }),
    raiseTask,
  });
}

/** A revert from `occurrence`, served, whose capture shows `text` and ended on `url`. */
export function revertAt(
  occurrence: Occurrence | undefined,
  text: string,
  url: string = PAGE,
  raiseTask: PublishPorts['raiseTask'] = async () => {},
): Promise<RevertOutcome> {
  return revertCorrection(
    { publishedRevision: 'rev-1', target: about, occurrence, seam: 'revert-982', decidedAt: 0 },
    {
      now: () => 1000,
      readBack: async () => ({ state: 'absent' }),
      revert: async () => ({ kind: 'ok', value: { revision: 'rev-2', deploymentId: 'dep-2' } }),
      readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev-2', served: true } }),
      capture: async () => ({ ok: true, value: { text, url } }),
      raiseTask,
    },
  );
}
