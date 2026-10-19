// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the world's commands, one beside the next */
//
// C35-X's world (#2014, the version half): C35's, in which eve, beta's one operator, also
// manages beta's settings, and fay in alpha holds the review keys and no gate key. With the
// decision and Astra-review commands, and a revision opened as the fixture's agent acting
// for a person, through the records' own open.

import { randomUUID } from 'node:crypto';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { openPageReview } from '../../packages/core-records/src/review/reviews.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';

const WHOLE = { kind: 'business', id: null } as const;
export const ASTRA = 'Astra: the heading and the hero read as asked at both widths.';

type Body = Readonly<Record<string, unknown>>;

export interface C35XWorld extends C35World {
  /** Review keys in alpha, no gate key. */
  readonly fay: Member;
  decide(member: Member, at: Opened, business?: string, overrides?: Body): Promise<CommandResult>;
  astra(
    member: Member,
    at: Opened,
    verdict?: string,
    business?: string,
    overrides?: Body,
  ): Promise<CommandResult>;
  setMode(business: string, member: Member, value: boolean): Promise<CommandResult>;
  /** A revision of alpha's review of task A opened by the fixture's agent for `person`. */
  openAsAgentFor(person: Member): Promise<Opened>;
  decisions(business: string): Promise<readonly Record<string, unknown>[]>;
}

export interface Opened {
  readonly reviewId: string;
  readonly revisionId: string;
  readonly digest: string;
}

/**
 * A command's answer; a command the build does not declare throws, and that is answered as a
 * refusal `UNDECLARED`, so a case meets its own assertion.
 */
const answered = async (asked: Promise<CommandResult>): Promise<CommandResult> =>
  await asked.catch(
    (error: unknown) =>
      ({ refused: true, code: 'UNDECLARED', names: [], fixes: [String(error)] }) as never,
  );

export const openedOf = (detail: Readonly<Record<string, unknown>>): Opened => ({
  reviewId: String(detail['reviewId']),
  revisionId: String(detail['revisionId']),
  digest: String(detail['digest']),
});

export async function c35xWorld(part: string): Promise<C35XWorld> {
  const w = await c35World(part);
  const alpha = w.world.business;
  await w.world.db.app.withBusiness(w.beta, async (tx) => {
    await grantTo(tx, w.eve, 'manage', WHOLE, false, 'settings');
  });
  const fay = await enrol(w.world.db.app, alpha, 'fay');
  await w.world.db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['write', 'read', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one grant after another, in one transaction
      await grantTo(tx, fay, action, WHOLE, false, 'review');
    }
  });
  return {
    ...w,
    fay,
    decide: async (member, at, business = alpha, overrides = {}) =>
      await answered(
        w.asIn(business, member, {
          command: 'review.decide',
          reviewId: at.reviewId,
          digest: at.digest,
          response: 'approve',
          ...overrides,
        }),
      ),
    astra: async (member, at, verdict = 'approve', business = alpha, overrides = {}) =>
      await answered(
        w.asIn(business, member, {
          command: 'review.record_astra_review',
          reviewId: at.reviewId,
          digest: at.digest,
          verdict,
          review: ASTRA,
          ...overrides,
        }),
      ),
    setMode: async (business, member, value) =>
      await answered(w.asIn(business, member, { command: 'settings.set_single_operator', value })),
    openAsAgentFor: async (person) =>
      await w.world.db.app.withBusiness(alpha, async (tx) => {
        const opened = await openPageReview(tx, {
          taskId: w.taskA,
          pageUrl: PAGE,
          path: ABOUT,
          sourceRevision: `rev-agent-${randomUUID().slice(0, 8)}`,
          writer: { actorId: w.world.agentActorId, personId: person.personId, delegationId: null },
        });
        if ('code' in opened) throw new Error(`openAsAgentFor: ${opened.code}`);
        return {
          reviewId: opened.review.id,
          revisionId: opened.revision.id,
          digest: opened.revision.digest,
        };
      }),
    decisions: async (business) =>
      await w.world.db.admin
        .execute<{ readonly row: Record<string, unknown> }>(
          `select to_jsonb(d) as row from public.review_decisions d
            where business_id = $1 order by created_at, id`,
          [business],
        )
        .catch(() => [])
        .then((rows) => rows.map((one) => one.row)),
  };
}
