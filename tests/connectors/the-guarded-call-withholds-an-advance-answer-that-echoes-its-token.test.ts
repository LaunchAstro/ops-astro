// SPDX-License-Identifier: AGPL-3.0-only
//
// The guarded call's own echo check on the advance's answer, with custody left
// out (the transport answers directly), so custody's separate withholding cannot
// hide it: the borrowed token in `object.sha`, in `ref`, or split across both
// leaves the write `unknown` (`PROVIDER_CREDENTIAL_ECHOED`) and never returns.
// Mutant that turns it red: drop the joined reading of the kept fields.

import { expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  type CallDependencies,
} from '../../packages/core-connectors/src/index.ts';

const TOKEN = 'canary-advance-token-4f1e9c';
const half = TOKEN.length / 2;

const deps = (body: unknown): CallDependencies => ({
  transport: () =>
    Promise.resolve({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    }),
  resolve: () => Promise.resolve(['140.82.112.6']),
  credential: () => Promise.resolve(TOKEN),
  record: () => null,
});

const plants: readonly (readonly [string, unknown])[] = [
  ['the commit', { ref: 'refs/heads/main', object: { sha: TOKEN } }],
  ['the ref', { ref: TOKEN, object: { sha: 'c0ffee01' } }],
  ['split across both', { ref: TOKEN.slice(half), object: { sha: TOKEN.slice(0, half) } }],
];

it.each(plants)('withholds an answer echoing the token in %s', async (_, body) => {
  const advance = SITE_OPERATIONS.find(
    (entry) => entry.declaration.operation_name === 'site.source.advance',
  );
  expect(advance?.connector.method).toBe('PATCH');
  if (advance === undefined) return;
  const answer = await callConnector(
    advance,
    { repository: 'agency/site', branch: 'main', sha: 'c0ffee01' },
    deps(body),
  );
  expect(answer).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  expect(JSON.stringify(answer)).not.toContain(TOKEN.slice(0, 6));
});
