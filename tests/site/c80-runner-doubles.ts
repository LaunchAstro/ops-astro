// SPDX-License-Identifier: AGPL-3.0-only
//
// Doubles of the source control and hosting connectors for C80's runner
// tests, and the C18-1 fence's own inputs for the capture: the catalogue pool,
// a resolver and a transport serving the page. Each call is counted, nothing
// leaves the process.

import { AFTER, BEFORE, PAGE } from './c80-world.ts';
import type { RunnerPorts } from '../../packages/core-commands/src/index.ts';
import type {
  CaptureOptions,
  FenceRefusal,
  Transport,
} from '../../packages/core-connectors/src/index.ts';

const PROVIDER_URL = 'https://deploy-preview.example/';
export const PUBLIC_ADDRESS = '93.184.215.14';

export interface Seen {
  dispatched: { dispatchToken: string; versionDigest: string }[];
  /** Every address the capture's transport was asked to fetch, as fetched. */
  captured: string[];
  /** Every host the capture's resolver was asked for. */
  resolved: string[];
  /** What the fence recorded of each refusal: code, hop and origin only. */
  fenceRefusals: FenceRefusal[];
  sourceReads: number;
  reverted: number;
  raised: string[];
}

const html = (text: string): Uint8Array =>
  new TextEncoder().encode(`<!doctype html><html><body><main>${text}</main></body></html>`);

/** The fence's inputs: a pool holding the agency's page, a public resolver, a transport serving it. */
function fenceDouble(seen: Seen, page: () => string): CaptureOptions {
  const transport: Transport = (request) => {
    seen.captured.push(request.url.href);
    return Promise.resolve({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html(page()),
    });
  };
  return {
    pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
    resolve: (host) => {
      seen.resolved.push(host);
      return Promise.resolve([PUBLIC_ADDRESS]);
    },
    transport,
    record: (refusal) => seen.fenceRefusals.push(refusal),
  };
}

/** Doubles of the providers, and the fence over a pool holding the agency's page. */
export function doubles(
  overrides: Partial<Omit<RunnerPorts, 'capture'>> = {},
  fence: Partial<CaptureOptions> = {},
): RunnerPorts & { seen: Seen } {
  const seen: Seen = {
    dispatched: [],
    captured: [],
    resolved: [],
    fenceRefusals: [],
    sourceReads: 0,
    reverted: 0,
    raised: [],
  };
  let clock = 1_000;
  let page = AFTER;
  return {
    seen,
    readSource: () => {
      seen.sourceReads += 1;
      return Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'rev-1' } });
    },
    publish: (input) => {
      seen.dispatched.push(input);
      return Promise.resolve({
        kind: 'ok',
        value: { revision: 'rev-2', deploymentId: 'dep-2', liveUrl: PROVIDER_URL },
      });
    },
    readDeployment: (id) =>
      Promise.resolve({
        kind: 'ok',
        value: { revision: id === 'dep-3' ? 'rev-3' : 'rev-2', served: true },
      }),
    capture: { ...fenceDouble(seen, () => page), ...fence },
    revert: () => {
      seen.reverted += 1;
      page = BEFORE;
      return Promise.resolve({ kind: 'ok', value: { revision: 'rev-3', deploymentId: 'dep-3' } });
    },
    raiseTask: (reason) => {
      seen.raised.push(reason);
      return Promise.resolve();
    },
    now: () => (clock += 250),
    refusals: () => seen.fenceRefusals.map((refusal) => refusal.code),
    ...overrides,
  };
}
