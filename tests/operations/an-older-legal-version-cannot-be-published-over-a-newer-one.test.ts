// SPDX-License-Identifier: AGPL-3.0-only
//
// Publishing follows the version order. Two versions of the client terms are
// approved; the later one is published; then the older one is published. The
// older one is refused `LEGAL_VERSION_SUPERSEDED` and the public address still
// serves the later one, so an approved version left unpublished can never roll
// the terms back. Published in order, both publish.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  approve,
  closeLegal,
  detailOf,
  digestOf,
  draft,
  draftBody,
  openLegal,
  publish,
  readPublic,
} from './c81-legal-documents-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await openLegal('legal_order');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeLegal();
});

/** A drafted and approved version of `document`; answers its id and body. */
async function approved(document: string, version: string) {
  const body = draftBody({ document, version, body: `# Terms\n\nVersion ${version}.\n` });
  const versionId = detailOf(await draft(body))['versionId'];
  expect((await approve(versionId, digestOf(body.body))).code).toBe('ok');
  return { versionId, body };
}

const servedVersion = async (document: string): Promise<unknown> =>
  (JSON.parse((await readPublic('alpha', document)).text) as { readonly version?: unknown })
    .version;

it.skipIf(serverUrl === undefined)(
  'an older approved version published after a newer one is refused and the newer one stays current',
  async () => {
    const older = await approved('client-terms', '1.9');
    const newer = await approved('client-terms', '1.10');
    expect((await publish(newer.versionId)).code).toBe('ok');
    const late = await publish(older.versionId);
    expect({ status: late.status, code: late.code }).toStrictEqual({
      status: 409,
      code: 'LEGAL_VERSION_SUPERSEDED',
    });
    expect(await servedVersion('client-terms')).toBe('1.10');
  },
);

it.skipIf(serverUrl === undefined)('versions published in order each publish', async () => {
  const first = await approved('data-handling', '2.0');
  const second = await approved('data-handling', '2.1');
  expect((await publish(first.versionId)).code).toBe('ok');
  expect((await publish(second.versionId)).code).toBe('ok');
  expect(await servedVersion('data-handling')).toBe('2.1');
});
