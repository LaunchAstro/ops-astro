// SPDX-License-Identifier: AGPL-3.0-only
//
// S1922-7 (#2071): the head lookup the locate pins from (`site.source.head`)
// reads a default branch with a slash, such as `release/live`, as the source
// read already does, segment by segment under the same segment check, and
// still refuses a branch that check refuses. Rebuilt from Sol's proof
// `sol1922-head-branch.proof.test.ts` (its log: polish/sol-pr1922-7997358-nv_zl41g/
// sol-evidence/sol1922-head-branch-proof.log), whose file did not survive.

import { expect, it } from 'vitest';
import {
  callConnector,
  siteOperation,
  type CallDependencies,
  type TransportAnswer,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const SHA = 'a'.repeat(40);

function json(value: unknown): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function deps(sent: TransportRequest[], answer: unknown): CallDependencies {
  return {
    resolve: () => Promise.resolve(['140.82.112.6']),
    credential: () => Promise.resolve('synthetic-source-key'),
    record: () => {},
    transport: (request) => {
      sent.push(request);
      return Promise.resolve(json(answer));
    },
  };
}

const head = async (branch: string, sent: TransportRequest[] = []) =>
  await callConnector(
    siteOperation('site.source.head'),
    { repository: 'owner/site', branch },
    deps(sent, { object: { sha: SHA } }),
  );

it('the source read accepts the slash default branch as its ref', async () => {
  const sent: TransportRequest[] = [];
  const read = await callConnector(
    siteOperation('site.source.read'),
    { repository: 'owner/site', path: 'src/pages/about.md', ref: 'release/live' },
    deps(sent, { sha: 'blob', content: 'Zm9v', encoding: 'base64' }),
  );
  expect(read.kind).toBe('ok');
  expect(sent[0]?.url.searchParams.get('ref')).toBe('release/live');
});

it('head lookup reads an ordinary branch', async () => {
  expect(await head('main')).toStrictEqual({ kind: 'ok', value: { 'object.sha': SHA } });
});

it('head lookup accepts the slash default branch already accepted by source reads', async () => {
  const sent: TransportRequest[] = [];
  expect(
    await head('release/live', sent),
    'a valid slash branch must be readable to pin its correction',
  ).toStrictEqual({
    kind: 'ok',
    value: { 'object.sha': SHA },
  });
  expect(sent[0]?.url.pathname).toBe('/repos/owner/site/git/ref/heads/release/live');
});

it('head lookup still refuses what the segment check refuses, and sends nothing', async () => {
  for (const branch of [
    '..',
    'release/../main',
    'release//live',
    '/live',
    'release/',
    'rel ease',
    '',
  ]) {
    const sent: TransportRequest[] = [];
    // oxlint-disable-next-line no-await-in-loop -- one refusal per hostile name
    expect(await head(branch, sent), branch).toStrictEqual({
      kind: 'refused',
      code: 'PARAMETER_INVALID',
    });
    expect(sent, branch).toHaveLength(0);
  }
});
