// SPDX-License-Identifier: AGPL-3.0-only
//
// Doubles of the source control and hosting connectors and the fenced capture
// for C80's runner tests: each call is counted, nothing leaves the process.

import { AFTER, BEFORE } from './c80-world.ts';
import type { RunnerPorts } from '../../packages/core-commands/src/index.ts';

const PROVIDER_URL = 'https://deploy-preview.example/';

export interface Seen {
  dispatched: { dispatchToken: string; versionDigest: string }[];
  captured: string[];
  reverted: number;
  raised: string[];
}

/** Doubles of the source control and hosting connectors and the fenced capture. */
export function doubles(overrides: Partial<RunnerPorts> = {}): RunnerPorts & { seen: Seen } {
  const seen: Seen = { dispatched: [], captured: [], reverted: 0, raised: [] };
  let clock = 1_000;
  let page = AFTER;
  return {
    seen,
    readSource: () =>
      Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'rev-1' } }),
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
    capture: (url) => {
      seen.captured.push(url);
      return Promise.resolve({ ok: true, value: { text: page } });
    },
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
    refusals: () => [],
    ...overrides,
  };
}
