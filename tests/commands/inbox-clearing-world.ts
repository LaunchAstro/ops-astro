// SPDX-License-Identifier: AGPL-3.0-only
//
// The world INB-1c's two clearing suites share: one migrated business with a
// member and a second reviewer who both hold decide on every task, a writer
// who proposes and holds no decide, and a second business with one person.
// Items are read straight from the table as the owner reads it, so no read
// path and no live update stands between a decision and what is asserted.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Hono } from 'hono';
import type { InboxItem } from '../../packages/core-records/src/index.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

export const ok = (answer: Answer): Answer => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer;
};

const proposal = (task: { id: string; rev: number }) => ({
  recordId: task.id,
  expectedRevision: task.rev,
  purpose: 'draft_reply',
  maximumMinor: 1_000,
  currency: 'AUD',
  payload: { instruction: 'draft' },
  step: { kind: 'compose', payload: {} },
});

/** Only a readable item carries its pointers; a withheld or gone one names nothing (INB-1a). */
export const readable = (
  item: InboxItem,
): item is Extract<InboxItem, { readonly access: 'readable' }> => item.access === 'readable';

export const decideBody = (
  gate: { gateId: string; versionId: string },
  decision = 'approve',
): Readonly<Record<string, string>> => ({
  gateId: gate.gateId,
  versionId: gate.versionId,
  decision: decision,
  note: 'decided',
});

export interface ItemRow {
  readonly recipient: string;
  readonly work_state: string;
  readonly closed_by: string | null;
  readonly operation: string | null;
  readonly closed_at: Date | null;
}

export interface Proposed {
  readonly task: { readonly id: string; readonly rev: number };
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

export class ClearingWorld {
  fixture!: ApiFixture;
  api!: Hono;
  memberToken = '';
  reviewer!: Member;
  reviewerToken = '';
  writer!: Member;
  writerToken = '';
  bravo = '';
  bravoPerson = '';

  async call(
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string = this.memberToken,
  ): Promise<Answer> {
    return await post(
      this.api,
      `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
      { operationId: randomUUID(), ...body },
      authorised(token),
    );
  }

  /** A task, on a client when one is named. */
  task = async (title: string, client?: string): Promise<{ id: string; rev: number }> => {
    const created = ok(await this.call('task.create', { fields: { title } })).body;
    const id = String(created['recordId']);
    if (client === undefined) return { id, rev: Number(created['revision']) };
    const [set] = await this.fixture.db.admin.execute<{ revision: string }>(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1 returning revision::text as revision`,
      [id, client],
    );
    return { id, rev: Number(set?.revision) };
  };

  /** A task, on a client when one is named, with a proposal whose gate raised its items. */
  async proposed(title: string, client?: string): Promise<Proposed> {
    const task = await this.task(title, client);
    const detail = detailOf(ok(await this.call('task.propose', proposal(task), this.writerToken)));
    return {
      task,
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      lineageId: String(detail['lineageId']),
    };
  }

  /** Straight from the table as the owner reads it: no read path, no live update. */
  async itemsOnFact(factId: string): Promise<readonly ItemRow[]> {
    return await this.fixture.db.admin.execute<ItemRow>(
      `select recipient_person_id as recipient, work_state, closed_by_person_id as closed_by,
              closed_by_operation_id as operation, closed_at
         from public.inbox_items where fact_id = $1 and reason = 'decision'
        order by recipient_person_id`,
      [factId],
    );
  }

  async gateState(gateId: string): Promise<{ state: string; decisions: number }> {
    const [row] = await this.fixture.db.admin.execute<{ state: string; decisions: string }>(
      `select g.state, (select count(*) from public.gate_decisions d where d.gate_id = g.id)::text
                as decisions
         from public.gates g where g.id = $1`,
      [gateId],
    );
    return { state: String(row?.state), decisions: Number(row?.decisions) };
  }

  holders(): string[] {
    return [this.fixture.member.personId, this.reviewer.personId].toSorted();
  }
}

/** Build the world before the suite and drop its database after. */
export function clearingWorld(part: string): ClearingWorld {
  const w = new ClearingWorld();
  beforeAll(async () => {
    w.fixture = await createApiFixture(part);
    w.api = w.fixture.compose();
    w.memberToken = await tokenFor(w.fixture.member.presented.subject);
    w.reviewer = await enrol(w.fixture.db.app, w.fixture.business, 'Rhea Reviewer');
    w.writer = await enrol(w.fixture.db.app, w.fixture.business, 'Wes Writer');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      // Sequential: `issueGrant` reads the granter's own rows.
      for (const action of ['read', 'decide'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, w.reviewer, action);
      }
      for (const action of ['read', 'write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, w.writer, action);
      }
    });
    w.reviewerToken = await tokenFor(w.reviewer.presented.subject);
    w.writerToken = await tokenFor(w.writer.presented.subject);
    w.bravo = await insertBusiness(w.fixture.db.app, 'bravo');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      w.bravoPerson = await insertPerson(tx, 'Bruno Bravo');
      await insertActor(tx, w.bravoPerson);
    });
  }, 120_000);
  afterAll(async () => {
    await w.fixture?.drop();
  });
  return w;
}
