// SPDX-License-Identifier: AGPL-3.0-only
//
// R5 (#1689): single-operator mode stands only while the business has exactly
// one operator, so ending the sole operator turns it off as adding a second
// does; Astra's latest review of a version is the one that counts, so a later
// changes-requested result withdraws an earlier approval; and recording a
// review or deciding stays within the caller's business, client and configured
// person. Each case builds a world of its own.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import {
  soloWorld,
  setMode,
  modeIn,
  eveRequests,
  recordReview,
  decide,
  rowOf,
} from './single-operator-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Single-operator operators and reviews: DATABASE_URL is unset, so nothing ran.');

describe.skipIf(serverUrl === undefined)('single-operator mode and Astra’s latest review', () => {
  it('turns single-operator mode off when the sole operator is ended', async () => {
    const w = await soloWorld('sol1788zero');
    expect(codeOf(await setMode(w, w.beta, w.eve, true))).toBe('not-a-refusal');
    await w.world.db.app.withBusiness(w.beta, async (tx) => {
      await tx.query(
        `update public.memberships set active = false, ended_at = now()
      where business_id = $1 and person_id = $2`,
        [w.beta, w.eve.personId],
      );
    });
    expect(await modeIn(w, w.beta)).toBe(false);
  });

  it('lets a later changes-requested review supersede an earlier approval of the same version', async () => {
    const w = await soloWorld('sol1788review');
    expect(codeOf(await setMode(w, w.beta, w.eve, true))).toBe('not-a-refusal');
    const own = await eveRequests(w);
    expect(codeOf(await recordReview(w, own.id, own.digest, 'approve'))).toBe('not-a-refusal');
    expect(codeOf(await recordReview(w, own.id, own.digest, 'changes_requested'))).toBe(
      'not-a-refusal',
    );
    const result = await decide(w, own);
    expect(codeOf(result)).toBe('ASTRA_REVIEW_MISSING');
    expect(await rowOf(w, own.id)).toMatchObject({ state: 'requested' });
  });
});

describe.skipIf(serverUrl === undefined)('the review and the decision, across a crossing', () => {
  it('keeps the review and the decision within their business, client and configured person', async () => {
    const w = await soloWorld('sol1788sep');
    expect(codeOf(await setMode(w, w.beta, w.eve, true))).toBe('not-a-refusal');
    const own = await eveRequests(w);
    const body = {
      command: 'live_correction.record_review',
      correctionId: own.id,
      versionDigest: own.digest,
      verdict: 'approve',
      review: 'Astra saved review',
    };
    expect(codeOf(await w.as(w.ava, body))).toBe('NOT_FOUND');
    const asked = await w.request(w.ava);
    if ('refused' in asked) throw new Error('request refused');
    const alphaId = String(asked.detail['correctionId']);
    const alphaDigest = String(asked.detail['versionDigest']);
    expect(
      codeOf(await w.as(w.dee, { ...body, correctionId: alphaId, versionDigest: alphaDigest })),
    ).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.approve(w.cal, alphaId, String(asked.detail['versionId'])))).toBe(
      'APPROVER_NOT_CONFIGURED_ONE',
    );
    expect(await rowOf(w, alphaId)).toMatchObject({ state: 'requested' });
  });
});
