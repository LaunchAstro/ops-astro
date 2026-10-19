// SPDX-License-Identifier: AGPL-3.0-only
//
// S2061-4, through the real boundary: noah, holding no grant, sends the audit
// matrix's own review.read probe. Authority refuses it SCOPE_NOT_GRANTED, and the
// one audit row it writes records that code, not an operand error.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { createIdentWorld, type IdentWorld } from '../acceptance/ident-audit-cases.ts';
import { auditMark, auditSince } from '../acceptance/ident-audit-rows.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: IdentWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await createIdentWorld('reviewreadprobe');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe.skipIf(serverUrl === undefined)('the review.read audit probe', () => {
  it('a member with no grant sending the probe is refused SCOPE_NOT_GRANTED and audited so', async () => {
    const { operationId: ignored, ...probe } = w.h.probeBody(declarationOf('review.read'));
    void ignored;
    const mark = await auditMark(w.h);
    const result = await w.person(w.h.world.noah, 'review.read', {
      operationId: randomUUID(),
      ...probe,
    });
    expect(result.code).toBe('SCOPE_NOT_GRANTED');
    const rows = await auditSince(w.h, mark);
    expect(rows.map((row) => [row.business_id, row.command, row.refusal_code])).toStrictEqual([
      [w.h.world.alpha, 'review.read', 'SCOPE_NOT_GRANTED'],
    ]);
  });
});
