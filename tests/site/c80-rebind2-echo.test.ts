// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 rebind 2 L1: the guarded provider call meeting a provider that echoes
// the borrowed credential encoded or split, against a double of the source
// control connector. The verbatim echo's proof is in c80-hostile-provider.
//
// Out of reach, by design: an arbitrary transform (hex, a cipher, a reversal,
// two layers of encoding) cannot be caught by any scan, and the borrowed
// credential's own scope bounds what a provider that echoes it could expose.

import { expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  type Transport,
} from '../../packages/core-connectors/src/index.ts';

const canary = 'canary-token-C80-never-shown';
const read = SITE_OPERATIONS.find(
  (entry) => entry.declaration.operation_name === 'site.source.read',
)!;
const percent = (text: string) =>
  [...text].map((char) => `%${(char.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`).join('');
const base64url = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** Answers to a source read, each in its declared schema `{ sha, content, encoding }`. */
const ROWS = {
  // GitHub's contents API answers base64 with a line break every 60 characters.
  'base64 content': {
    sha: 'abc',
    content: btoa(`const key = "${canary}";\n`).replaceAll(/(.{60})/gu, '$1\n'),
  },
  base64url: { sha: base64url(`>>${canary}??`), content: 'PHA+' },
  'percent-encoded': { sha: percent(canary), content: 'PHA+' },
  'split across two fields': { sha: canary.slice(0, 12), content: canary.slice(12) },
  'clean content (control)': { sha: 'abc', content: btoa('<p>Hi</p>\n') },
};

const answering =
  (body: object): Transport =>
  () =>
    Promise.resolve({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ ...body, encoding: 'base64' })),
    });

it('Rebind 2 L1: a credential echoed encoded or split across fields cannot escape', async () => {
  const recorded: string[] = [];
  const results = Object.fromEntries(
    await Promise.all(
      Object.entries(ROWS).map(async ([row, body]) => {
        const result = await callConnector(
          read,
          { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' },
          {
            transport: answering(body),
            resolve: () => Promise.resolve(['140.82.112.6']),
            credential: () => Promise.resolve(canary),
            record: (code) => recorded.push(code),
          },
        );
        return [row, result] as const;
      }),
    ),
  );
  // A boolean, so a failure never prints the credential.
  expect(JSON.stringify({ results, recorded }).includes(canary)).toBe(false);
  const codes = Object.entries(results).map(([row, got]) => [row, 'code' in got ? got.code : 'ok']);
  expect(Object.fromEntries(codes)).toEqual({
    'base64 content': 'PROVIDER_CREDENTIAL_ECHOED',
    base64url: 'PROVIDER_CREDENTIAL_ECHOED',
    'percent-encoded': 'PROVIDER_CREDENTIAL_ECHOED',
    'split across two fields': 'PROVIDER_CREDENTIAL_ECHOED',
    'clean content (control)': 'ok',
  });
});
