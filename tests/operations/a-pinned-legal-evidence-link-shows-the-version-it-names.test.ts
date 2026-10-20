// SPDX-License-Identifier: AGPL-3.0-only
//
// A legal evidence link (`legalVersionPath`) names a version and the digest of
// its words. Read through the public route, it shows that version after a
// newer one is published, and only while the digest matches: a wrong digest,
// half a pin, an unpublished draft and another business's version answer the
// one 404 the route gives for anything it does not publish. With no pin the
// route still answers the latest publication. The breach runbook's link opens
// the operations view, whose read takes the same pin.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import {
  closeLegal,
  digestOf,
  draft,
  draftBody,
  harness,
  openLegal,
  publicPath,
  released,
} from './c81-legal-documents-world.ts';

let v1: { readonly version: string; readonly body: string; readonly digest: string };
let v2: { readonly version: string; readonly body: string };
let runbook1: { readonly body: string; readonly digest: string };
let runbook2: { readonly body: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await openLegal('pinned_legal_link');
  const first = await released({ document: 'client-terms', version: '1.0' });
  v1 = {
    version: '1.0',
    body: String(first.body.body),
    digest: digestOf(String(first.body.body)),
  };
  const second = await released({ document: 'client-terms', version: '2.0' });
  v2 = { version: '2.0', body: String(second.body.body) };
  const firstRunbook = String(
    (await released({ document: 'breach-runbook', version: '1.0' })).body.body,
  );
  runbook1 = { body: firstRunbook, digest: digestOf(firstRunbook) };
  runbook2 = {
    body: String((await released({ document: 'breach-runbook', version: '2.0' })).body.body),
  };
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeLegal();
});

async function read(
  query: string,
  businessKey = 'alpha',
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await harness.world.api.request(
    `${publicPath(businessKey, 'client-terms')}${query}`,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const pin = (version: string, digest: string): string =>
  `?version=${encodeURIComponent(version)}&digest=${encodeURIComponent(digest)}`;

describe.skipIf(serverUrl === undefined)('a pinned legal evidence link', () => {
  it('shows the version it names, with its own words, after a newer one is published', async () => {
    const pinned = await read(pin(v1.version, v1.digest));
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({ version: '1.0', body: v1.body, digest: v1.digest });
    expect(JSON.stringify(pinned.body)).not.toContain(v2.body);
  });

  it('still answers the latest publication when the address names no version', async () => {
    const latest = await read('');
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ version: '2.0', body: v2.body });
  });

  it('refuses a wrong digest, or half a pin, with the one not-found answer', async () => {
    for (const query of [
      pin(v1.version, digestOf('other words')),
      `?version=${v1.version}`,
      `?digest=${v1.digest}`,
      pin('9.9', v1.digest),
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await read(query);
      expect({ query, status: answer.status, body: answer.body }).toStrictEqual({
        query,
        status: 404,
        body: { code: 'NOT_FOUND' },
      });
    }
  });

  it('never shows an unpublished draft, however exactly it is pinned', async () => {
    const body = draftBody({ document: 'client-terms', version: '3.0' });
    expect((await draft(body)).code).toBe('ok');
    const answer = await read(pin('3.0', digestOf(String(body.body))));
    expect(answer).toStrictEqual({ status: 404, body: { code: 'NOT_FOUND' } });
  });

  it("never shows one business's version at another business's address", async () => {
    const answer = await read(pin(v1.version, v1.digest), 'bravo');
    expect(answer).toStrictEqual({ status: 404, body: { code: 'NOT_FOUND' } });
  });
});

/** The operations view as Noah (`operations:read` alone) reads it, with `operands`. */
const operations = async (operands: Readonly<Record<string, unknown>>): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath('alpha', '/operations/read'),
    { operationId: `pin-${randomUUID()}`, ...operands },
    bearer(harness.world.noah.token),
  );

const runbookOf = (answer: Answer): unknown => answer.body['breachRunbook'];

describe.skipIf(serverUrl === undefined)("the breach runbook's pinned link", () => {
  it('opens the operations view on the version it names, after a newer one is published', async () => {
    const pinned = await operations({ runbookVersion: '1.0', runbookDigest: runbook1.digest });
    expect(pinned.code).toBe('ok');
    expect(runbookOf(pinned)).toMatchObject({ version: '1.0', body: runbook1.body });
    expect(runbookOf(await operations({}))).toMatchObject({ version: '2.0', body: runbook2.body });
  });

  it('shows no runbook for a pin whose digest names other words', async () => {
    const wrong = await operations({ runbookVersion: '1.0', runbookDigest: digestOf('other') });
    expect(wrong.code).toBe('ok');
    expect(runbookOf(wrong)).toBeNull();
  });

  it('refuses half a pin by the field that is missing', async () => {
    const half = await operations({ runbookVersion: '1.0' });
    expect({ code: half.code, names: half.body['names'] }).toStrictEqual({
      code: 'FIELD_VALUE_INVALID',
      names: ['runbookDigest'],
    });
  });
});
