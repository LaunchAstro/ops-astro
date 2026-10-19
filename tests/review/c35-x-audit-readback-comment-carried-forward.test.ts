// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2075): `comment carried forward (anchor lost)` is the worker's write under its
// lease, audited. The carry's operation leaves its own row in the chain and one row for each
// comment it carried, in that comment's history; the carry row names the same operation and
// says the anchor was lost. A refused carry leaves its refusal in the chain and no carry.
// The rows name identities only, never a comment's text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';
import {
  carriesOnto,
  carryUnder,
  landPage,
  landedReview,
  must,
  nextRevision,
  pinOn,
  quote,
} from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry audit: DATABASE_URL is unset.');

const BODY_MARKER = 'audit-body-marker-5530';

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xaudit');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35-X carry audit', () => {
  it('C35-X audit readback (comment carried forward (anchor lost))', async () => {
    const page = { text: 'Our team. Our team.', document: 'a' };
    const { reviewed, lease } = await landedReview(w, 'carry audit', page);
    const lost = await pinOn(w, reviewed.revisionId, {
      body: BODY_MARKER,
      selector: [spot(), quote('Our team')],
    });
    const second = await nextRevision(w, reviewed);
    expect(codeOf((await carryUnder(w, lease, second)).result)).toBe('CARRY_NOT_READY');
    await landPage(w, lease, second, { text: 'Our team. Our team.', document: 'f' });
    const carried = await carryUnder(w, lease, second);
    must(carried.result, 'review.carry_pins');

    const rows = await w.world.db.admin.execute<{
      readonly outcome: string;
      readonly refusal_code: string | null;
      readonly subject_record_id: string | null;
      readonly operation_id: string;
      readonly attempted: unknown;
    }>(
      `select outcome, refusal_code, subject_record_id, operation_id, attempted
         from public.audit_events
        where business_id = $1 and command = 'review.carry_pins' order by seq`,
      [w.world.business],
    );
    expect(rows.map((row) => [row.outcome, row.refusal_code])).toStrictEqual([
      ['refused', 'CARRY_NOT_READY'],
      ['applied', null],
      ['applied', null],
    ]);
    const applied = rows.filter((row) => row.outcome === 'applied');
    expect(applied.every((row) => row.operation_id === carried.operationId)).toBe(true);
    expect(applied.map((row) => row.subject_record_id)).toContain(lost);
    expect(JSON.stringify(rows)).not.toContain(BODY_MARKER);

    const [carry] = await carriesOnto(w, second);
    expect(carry).toMatchObject({
      comment_id: lost,
      state: 'lost',
      anchor: null,
      operation_id: carried.operationId,
    });
  }, 90_000);
});
