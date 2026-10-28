// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2120): an approval binds to the revision's recorded digest and nothing the live view
// could carry. `review.decide` refuses any field beyond the review, the digest and the response,
// and a digest the review never recorded (a frame's claim of what it shows) is stale; neither
// writes a decision. This held before #2120; the proof keeps it with the live view beside it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X live approval: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xliveapprove');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35-X approval and the live view', () => {
  it('an approval names only the recorded digest, never the live view', async () => {
    const opened = openedOf(detailOf(await w.open(w.fay)));
    const claims = [
      { liveViewport: 1480 },
      { live: true },
      { frameDigest: 'sha256:live' },
      { revisionId: opened.revisionId },
    ];
    for (const claim of claims) {
      // eslint-disable-next-line no-await-in-loop -- each refusal after the last
      expect(codeOf(await w.decide(w.ben, opened, w.world.business, claim))).toBe(
        'COMMAND_BODY_INVALID',
      );
    }
    expect(codeOf(await w.decide(w.ben, { ...opened, digest: 'sha256:live-dom' }))).toBe(
      'VERSION_STALE',
    );
    expect(await w.decisions(w.world.business)).toStrictEqual([]);

    expect(codeOf(await w.decide(w.ben, opened))).toBe('not-a-refusal');
    const decisions = await w.decisions(w.world.business);
    expect(decisions.map((row) => [row['revision_id'], row['digest']])).toStrictEqual([
      [opened.revisionId, opened.digest],
    ]);
  });
});
