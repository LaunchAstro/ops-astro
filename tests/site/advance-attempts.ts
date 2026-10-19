// SPDX-License-Identifier: AGPL-3.0-only
//
// A publish job and scripted ports for the advance's attempts: each send and each
// read back answers the next scripted value, so a case states exactly what the
// provider said and counts what was sent.

import {
  contentDigest,
  versionDigestOf,
  type ProviderResult,
  type PublishJob,
  type PublishPorts,
  type ReadBack,
} from '../../packages/core-connectors/src/index.ts';

/** What a publish answers once accepted. */
type Published = Extract<Awaited<ReturnType<PublishPorts['publish']>>, { kind: 'ok' }>['value'];

const TARGET = { path: 'src/pages/about.md', word: 'friendly', replacement: 'welcoming' };
const BEFORE = '<p>We are a friendly studio.</p>\n';
const AFTER = '<p>We are a welcoming studio.</p>\n';
const PAGE = 'https://agency.example/about/';

export const LANDED: Published = { revision: 'c0ffee01', liveUrl: PAGE };

export function job(): PublishJob {
  const change = { files: [{ path: TARGET.path, before: BEFORE, after: AFTER }] };
  const pinned = {
    target: TARGET,
    change,
    preImageDigest: contentDigest(BEFORE),
    baseRevision: 'base-commit',
    pageUrl: PAGE,
    seam: 'seam-5b0e2c1a-3d4f-4a6b-8c7d-9e0f1a2b3c4d',
  };
  const digest = versionDigestOf(pinned);
  return {
    correctionId: 'correction-1',
    ...pinned,
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'd-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
  };
}

export const timeout: ProviderResult<Published> = { kind: 'unknown', code: 'PROVIDER_TIMEOUT' };
export const refusal = (proof: string): ProviderResult<Published> => ({
  kind: 'refused',
  code: 'PROVIDER_REFUSED',
  proof,
});
export const landed: ReadBack<Published> = { state: 'landed', value: LANDED };
export const absent: ReadBack<Published> = { state: 'absent' };
export const unread: ReadBack<Published> = { state: 'unknown' };

export interface Script {
  readonly sends: readonly ProviderResult<Published>[];
  readonly backs: readonly ReadBack<Published>[];
}

/** The scripted answer at `at`; one past the end fails the case loudly. */
function next<T>(list: readonly T[], at: number, what: string): T {
  const value = list[at];
  if (value === undefined) throw new Error(`unscripted ${what} ${at + 1}`);
  return value;
}

/** Ports answering the script in order; a send or read past its end fails the case loudly. */
export function scripted(script: Script): PublishPorts & {
  readonly sent: () => number;
  readonly raised: string[];
} {
  let sends = 0;
  let backs = 0;
  const raised: string[] = [];
  return {
    sent: () => sends,
    raised,
    readSource: () => Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'blob' } }),
    readBack: () => Promise.resolve(next(script.backs, backs++, 'read back')),
    publish: () => Promise.resolve(next(script.sends, sends++, 'send')),
    cancellation: () => Promise.resolve('none'),
    raiseTask: (reason) => {
      raised.push(reason);
      return Promise.resolve();
    },
    capture: () =>
      Promise.resolve({ ok: true, value: { text: 'We are a friendly studio.', url: PAGE } }),
  };
}
