// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 hostile provider, the source-control and hosting paths: one catalogued
// call meeting a hostile answer, an unlisted destination, undeclared
// parameters and a planted credential canary.

import { describe, expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  type ConnectorResult,
  type Transport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const publishRegistration = SITE_OPERATIONS.find(
  (entry) => entry.declaration.operation_name === 'site.publish',
)!;

function httpOf(answer: Awaited<ReturnType<Transport>>): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  return Object.assign(
    (request: TransportRequest) => {
      seen.push(request);
      return Promise.resolve(answer);
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
  resolve: () => Promise.resolve(['140.82.112.6']),
  credential: () => Promise.resolve('canary-token-C80-never-shown'),
  record: (code: string) => recorded.push(code),
});

const params = { repository: 'site', number: '17' };

describe('C80 hostile provider (source control and hosting paths)', () => {
  it('returns only the declared response fields from a well-formed answer', async () => {
    const transport = httpOf(json({ merged: true, sha: 'def456', message: 'ok', token: 'leak' }));
    const result = await callConnector(publishRegistration, params, deps(transport));
    expect(result).toEqual({ kind: 'ok', value: { merged: true, sha: 'def456' } });
    expect(transport.seen[0]?.url.hostname).toBe(publishRegistration.connector.host);
  });
});

describe('C80 hostile provider (source control and hosting paths)', () => {
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
});

describe('C80 hostile provider (source control and hosting paths)', () => {
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
      resolve: () => Promise.resolve(['10.0.0.1']),
    });
    expect(result).toEqual({ kind: 'refused', code: 'DESTINATION_ADDRESS_DENIED' });
    expect(transport.seen).toHaveLength(0);
  });
});

describe('C80 hostile provider (source control and hosting paths)', () => {
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
