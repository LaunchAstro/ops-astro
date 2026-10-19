// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's matrix seed (#2014): the page's next revision, opened by another member, so a
// decision's author and decider differ. Kept beside `c35-bodies.ts` for its line cap.

import { randomUUID } from 'node:crypto';
import { enrol } from '../commands/fixture.ts';
import { openPageReview } from '../../packages/core-records/src/review/reviews.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { C80Seeds } from './c80-seeds.ts';

/** C35-X's seed (`C80Seeds`): the page's next revision, by a new member of `alpha`. */
export const reviseAsAnother =
  (world: {
    readonly db: { readonly app: Database };
    readonly alpha: string;
  }): Required<C80Seeds>['reviseAsAnother'] =>
  async (page) => {
    const reviser = await enrol(world.db.app, world.alpha, 'reviser');
    return await world.db.app.withBusiness(world.alpha, async (tx) => {
      const opened = await openPageReview(tx, {
        taskId: String(page['taskId']),
        pageUrl: String(page['pageUrl']),
        path: String(page['path']),
        sourceRevision: `rev-${randomUUID()}`,
        writer: { actorId: reviser.actorId, personId: reviser.personId, delegationId: null },
      });
      if ('code' in opened) throw new Error(`matrix: the second revision refused ${opened.code}`);
      return { digest: opened.revision.digest };
    });
  };
