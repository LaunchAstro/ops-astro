// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's command-layer world (#2016), on C35's: a client pin and an internal pin on task A's
// captured review, and the proposal keys. ava holds `proposal:write` and `proposal:decide`
// business-wide; ben `proposal:write` alone; dee both on party B only; eve both in beta. cal
// holds neither.

import { randomUUID } from 'node:crypto';
import { grantTo, type Member } from '../commands/fixture.ts';
import type { Scope } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

export interface Pins {
  readonly revisionId: string;
  readonly clientPin: string;
  readonly internalPin: string;
}

export interface C57World extends C35World {
  /** A fresh revision of task A's review, captured, with one client pin and one internal pin. */
  pins(clientBody?: string): Promise<Pins>;
  propose(
    member: Member,
    commentId: unknown,
    overrides?: Body,
    business?: string,
  ): Promise<CommandResult>;
  decide(
    member: Member,
    changeRequestId: unknown,
    decision: string,
    business?: string,
  ): Promise<CommandResult>;
  /** The change request rows in `business`, as the administrator reads them. */
  requests(business: string): Promise<readonly RequestRow[]>;
  /** Live tasks in `business`, counted as the administrator sees them. */
  tasks(business: string): Promise<number>;
}

export interface RequestRow {
  readonly id: string;
  readonly comment_id: string;
  readonly task_id: string;
  readonly party_id: string | null;
  readonly request_text: string;
  readonly state: string;
  readonly proposed_by_person_id: string;
  readonly decided_by_person_id: string | null;
  readonly created_task_id: string | null;
}

type Body = Readonly<Record<string, unknown>>;

const WHOLE: Scope = { kind: 'business', id: null };

async function proposalKeys(
  w: C35World,
  business: string,
  member: Member,
  scope: Scope,
  actions: readonly ('write' | 'decide')[],
) {
  await w.world.db.app.withBusiness(business, async (tx) => {
    for (const action of actions) {
      // eslint-disable-next-line no-await-in-loop -- one transaction's connection, one grant at a time
      await grantTo(tx, member, action, scope, false, 'proposal');
    }
  });
}

const countTasks = async (w: C35World, business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.records r
           join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
          where r.business_id = $1 and t.key = 'task' and r.deleted_at is null`,
        [business],
      )
    )[0]?.n,
  );

export async function c57World(part: string): Promise<C57World> {
  const w = await c35World(part);
  const alpha = w.world.business;
  await proposalKeys(w, alpha, w.ava, WHOLE, ['write', 'decide']);
  await proposalKeys(w, alpha, w.ben, WHOLE, ['write']);
  await proposalKeys(w, alpha, w.dee, { kind: 'party', id: w.partyB }, ['write', 'decide']);
  await proposalKeys(w, w.beta, w.eve, WHOLE, ['write', 'decide']);
  return {
    ...w,
    pins: async (clientBody = 'Can the heading sit above the photo?') => {
      const revisionId = String(detailOf(await w.open(w.ava))['revisionId']);
      await w.capture(w.ava, revisionId);
      const clientPin = detailOf(
        await w.pin(w.ava, revisionId, { audience: 'client', body: clientBody }),
      )['commentId'];
      const internalPin = detailOf(
        await w.pin(w.ava, revisionId, { selector: [spot('xywh=10,10,20,20')] }),
      )['commentId'];
      return { revisionId, clientPin: String(clientPin), internalPin: String(internalPin) };
    },
    propose: async (member, commentId, overrides = {}, business = alpha) =>
      await w.asIn(business, member, {
        command: 'review.propose_change',
        operationId: randomUUID(),
        commentId,
        text: 'Move the heading above the photo on the phone layout',
        ...overrides,
      }),
    decide: async (member, changeRequestId, decision, business = alpha) =>
      await w.asIn(business, member, {
        command: 'review.decide_change',
        operationId: randomUUID(),
        changeRequestId,
        decision,
      }),
    requests: async (business) =>
      await w.world.db.admin.execute<RequestRow>(
        `select id, comment_id, task_id, party_id, request_text, state, proposed_by_person_id,
                decided_by_person_id, created_task_id
           from public.review_change_requests where business_id = $1 order by created_at, id`,
        [business],
      ),
    tasks: async (business) => await countTasks(w, business),
  };
}
