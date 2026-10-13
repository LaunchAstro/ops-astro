// SPDX-License-Identifier: AGPL-3.0-only
//
// The guarded call's token-free mode: when its credential port answers a
// reference to a custody entry, no token is ever in the caller's process. The
// request leaves with no Authorization header, through the custody port, named
// by the entry; custody adds the credential and judges any echo. Stand-in
// ports only: nothing here reaches a provider.

import { expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  type CallDependencies,
  type CredentialReference,
  type CustodyAnswer,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly ref?: string;
}

const op = (name: string) =>
  SITE_OPERATIONS.find((entry) => entry.declaration.operation_name === name)!;

const json = (body: object): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const FOUND = {
  deployments: [{ uid: 'dpl_1', meta: { githubCommitSha: 'c0ffee' } }],
};

function world(answer: CustodyAnswer, credential?: string | CredentialReference) {
  const byCaller: Seen[] = [];
  const byCustody: Seen[] = [];
  const recorded: string[] = [];
  const deps: CallDependencies = {
    transport: (request) => {
      byCaller.push({ url: request.url.href, headers: request.headers });
      return Promise.resolve(json(FOUND));
    },
    resolve: () => Promise.resolve(['76.76.21.21']),
    credential: () => Promise.resolve(credential ?? { ref: 'hosting' }),
    custody: (request, reference) => {
      byCustody.push({ url: request.url.href, headers: request.headers, ref: reference.ref });
      return Promise.resolve(answer);
    },
    record: (code) => recorded.push(code),
  };
  return { deps, byCaller, byCustody, recorded };
}

const LOOKUP = { project: 'prj_abc', sha: 'c0ffee' };

it('a site call whose credential port answers a reference leaves with no Authorization header, through custody by the entry name', async () => {
  const { deps, byCaller, byCustody } = world(json(FOUND));
  const result = await callConnector(op('site.deployment.lookup'), LOOKUP, deps);
  // The caller's own transport never carries a credential header of the caller's making.
  expect(byCaller.filter((seen) => 'authorization' in seen.headers)).toEqual([]);
  expect(byCaller).toEqual([]);
  expect(byCustody).toHaveLength(1);
  expect(byCustody[0]?.ref).toBe('hosting');
  expect(byCustody[0]?.url).toBe(
    'https://api.vercel.com/v6/deployments?projectId=prj_abc&sha=c0ffee&target=production&limit=1',
  );
  expect(Object.keys(byCustody[0]?.headers ?? {})).not.toContain('authorization');
  expect(result).toEqual({
    kind: 'ok',
    value: { 'deployments.0.uid': 'dpl_1', 'deployments.0.meta.githubCommitSha': 'c0ffee' },
  });
});

it('an answer custody withheld as an echo is unreadable: a refused read, an unknown write', async () => {
  const read = world({ kind: 'echoed' });
  expect(await callConnector(op('site.deployment.lookup'), LOOKUP, read.deps)).toEqual({
    kind: 'refused',
    code: 'PROVIDER_CREDENTIAL_ECHOED',
  });
  const write = world({ kind: 'echoed' }, { ref: 'source_control' });
  const published = await callConnector(
    op('site.publish'),
    {
      repository: 'agency/site',
      path: 'src/pages/about.astro',
      message: 'm',
      content: 'PHA+',
      sha: 'abc',
      branch: 'main',
    },
    write.deps,
  );
  expect(published).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  expect(write.byCaller).toEqual([]);
  expect(write.recorded).toEqual(['PROVIDER_CREDENTIAL_ECHOED']);
});

it('custody refusing a write before sending it is a refusal, not an unknown', async () => {
  const write = world(
    { kind: 'refused', code: 'CUSTODY_ROUTE_REFUSED' },
    { ref: 'source_control' },
  );
  const published = await callConnector(
    op('site.publish'),
    {
      repository: 'agency/site',
      path: 'src/pages/about.astro',
      message: 'm',
      content: 'PHA+',
      sha: 'abc',
      branch: 'main',
    },
    write.deps,
  );
  expect(published).toEqual({ kind: 'refused', code: 'CUSTODY_ROUTE_REFUSED' });
});

it('a reference to another entry, or a reference with no custody port, sends nothing', async () => {
  const crossed = world(json(FOUND), { ref: 'source_control' });
  expect(await callConnector(op('site.deployment.lookup'), LOOKUP, crossed.deps)).toEqual({
    kind: 'refused',
    code: 'CREDENTIAL_UNAVAILABLE',
  });
  const portless = world(json(FOUND));
  const { custody: _dropped, ...withoutCustody } = portless.deps;
  expect(await callConnector(op('site.deployment.lookup'), LOOKUP, withoutCustody)).toEqual({
    kind: 'refused',
    code: 'CREDENTIAL_UNAVAILABLE',
  });
  expect([...crossed.byCaller, ...crossed.byCustody, ...portless.byCaller]).toEqual([]);
});

it('a borrowed token still goes by the caller transport for callers not moved (control)', async () => {
  const borrowed = world(json(FOUND), 'token-not-moved');
  const result = await callConnector(op('site.deployment.lookup'), LOOKUP, borrowed.deps);
  expect(result.kind).toBe('ok');
  expect(borrowed.byCustody).toEqual([]);
  expect(borrowed.byCaller[0]?.headers['authorization']).toBe('Bearer token-not-moved');
});
