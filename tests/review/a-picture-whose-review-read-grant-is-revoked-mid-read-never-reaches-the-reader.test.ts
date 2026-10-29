// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2121), Sol's S2147-3: the team picture read checks its grant in the covered picture
// query, then reads the picture's bytes from storage in a statement of its own. A reader's sole
// `review:read` grant revoked between them never reaches the former reader: the read is
// refused as one the grant does not cover, with no bytes, id or digest.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, pickUpReviewed, underReview, type C35World } from './c35-world.ts';
import { claimUnder, landUnder, pictureBytes } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('s2147picture');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/**
 * The app database, with ava's sole `review:read` grant revoked by the administrator right after
 * the covered picture query: before the bytes are read from storage, and not in that statement's
 * snapshot.
 */
function revokedAfterTheCoveredQuery(): {
  readonly database: Database;
  readonly crossed: () => boolean;
} {
  let crossed = false;
  const database: Database = {
    log: w.world.db.app.log,
    close: async () => {},
    withBusiness: async (business, run) =>
      await w.world.db.app.withBusiness(
        business,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, params) => {
              const rows = await tx.query(sql, params);
              if (!crossed && sql.includes('select k.picture_id from public.review_captures k')) {
                crossed = true;
                const revoked = await w.world.db.admin.execute(
                  `update public.grants set revoked_at = clock_timestamp()
                    where business_id = $1 and subject_id = $2 and collection = 'review'
                      and action = 'read' and revoked_at is null returning id`,
                  [w.world.business, w.ava.personId],
                );
                expect(revoked).toHaveLength(1);
              }
              return rows as never;
            },
          }),
      ),
  };
  return { database, crossed: () => crossed };
}

describe.skipIf(serverUrl === undefined)('the team picture read under revocation', () => {
  it('a picture whose review read grant is revoked mid-read never reaches the reader', async () => {
    const reviewed = await underReview(w, 'a picture read under revocation');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    const picture = pictureBytes(91);
    const { result } = await landUnder(w, lease, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture,
    });
    expect(codeOf(result)).toBe('not-a-refusal');
    const pictureId = String(detailOf(result)['pictureId']);
    const digest = String(detailOf(result)['pictureDigest']);
    const revoking = revokedAfterTheCoveredQuery();
    const answer = await executeRead(revoking.database, w.world.business, w.ava.presented, {
      read: 'review.picture',
      pictureId,
    } as never);
    expect(revoking.crossed()).toBe(true);
    const body = JSON.stringify(answer);
    expect({
      code: codeOf(answer as never),
      leaked: [pictureId, digest, picture.toString('base64')].filter((marker) =>
        body.includes(marker),
      ),
    }).toEqual({ code: 'NOT_FOUND', leaked: [] });
  }, 60_000);
});
