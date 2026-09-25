// SPDX-License-Identifier: AGPL-3.0-only
//
// A grant chain across two manager levels, and what revoking its root does to
// the grant at the bottom (SPEC:314, `revocation_bites_next_call`).
//
// The chain is built by the grant writer itself: a root grant issued
// administratively, a derived grant the first manager cuts from it, and a
// grandchild the second manager cuts from that. The writer's two refusals are
// reached on the way, each on its own ground. The revocation is the real
// `grant.revoke` route, and nothing below writes `revoked_at` by SQL: the
// bottom of the chain loses its authority only because `EFFECTIVE` stops at
// the revoked root. A second chain beside it is the control, and every call
// leaves exactly one audit row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  issueGrant,
  type Action,
  type ProposedGrant,
  type Subject,
} from '../../packages/core-records/src/authority/index.ts';
import { enrol, TASK_COLLECTION, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Chain {
  readonly first: Member;
  readonly second: Member;
  readonly leaf: Member;
  readonly rootId: string;
  readonly middleId: string;
  readonly leafId: string;
}

/** The two identities a member's session presents, as `subjectsOf` reads them. */
const granterOf = (member: Member): readonly Subject[] => [
  { kind: 'person', id: member.personId },
  { kind: 'actor', id: member.actorId },
];

/** The collection and action of every grant in the chain, unless a case widens it. */
const read = (action: Action = 'read') => ({ collection: TASK_COLLECTION, action });

describe.skipIf(serverUrl === undefined)('a two-level manager chain under grant.revoke', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('grchn');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** Issue through the writer, as `granter`, and hand back its decision. */
  const issue = async (granter: Member | null, proposed: Omit<ProposedGrant, 'scope'>) =>
    await c.fixture.db.app.withBusiness(
      c.fixture.business,
      async (tx) =>
        await issueGrant(tx, granter === null ? [] : granterOf(granter), {
          scope: WHOLE_BUSINESS,
          ...proposed,
        }),
    );

  async function buildChain(name: string): Promise<Chain> {
    const first = await enrol(c.fixture.db.app, c.fixture.business, `${name}-first`);
    const second = await enrol(c.fixture.db.app, c.fixture.business, `${name}-second`);
    const leaf = await enrol(c.fixture.db.app, c.fixture.business, `${name}-leaf`);
    const root = await issue(null, {
      subject: { kind: 'person', id: first.personId },
      ...read(),
      canDelegate: true,
      mayPermitDelegation: true,
      parentGrantId: null,
      grantedByActorId: c.manager.actorId,
    });
    if (!root.ok) throw new Error(`root refused ${root.refusal.code}`);
    const middle = await issue(first, {
      subject: { kind: 'person', id: second.personId },
      ...read(),
      canDelegate: true,
      parentGrantId: root.value,
      grantedByActorId: first.actorId,
    });
    if (!middle.ok) throw new Error(`middle refused ${middle.refusal.code}`);
    const bottom = await issue(second, {
      subject: { kind: 'person', id: leaf.personId },
      ...read(),
      parentGrantId: middle.value,
      grantedByActorId: second.actorId,
    });
    if (!bottom.ok) throw new Error(`leaf refused ${bottom.refusal.code}`);
    return {
      first,
      second,
      leaf,
      rootId: root.value,
      middleId: middle.value,
      leafId: bottom.value,
    };
  }

  const grantCount = async (): Promise<number> =>
    await c.count(`select count(*)::text as n from public.grants where business_id = $1`, [
      c.fixture.business,
    ]);

  const audited = async (member: Member, outcome: string): Promise<number> =>
    await c.count(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and actor_id = $2 and command = 'task.read' and outcome = $3`,
      [c.fixture.business, member.actorId, outcome],
    );

  /** One `task.read` as `member`, with the audit row it leaves counted. */
  async function readAs(member: Member, taskId: string) {
    const applied = await audited(member, 'applied');
    const refused = await audited(member, 'refused');
    const answer = await c.asPerson('task.read', { recordId: taskId }, member);
    const trail = {
      applied: (await audited(member, 'applied')) - applied,
      refused: (await audited(member, 'refused')) - refused,
    };
    return { answer, trail };
  }

  it('the writer refuses a derived grant broader or deeper than its parent, and writes nothing', async () => {
    const chain = await buildChain('refusals');
    expect(
      await c.count(
        `select count(*)::text as n from public.grants
          where id = any($1::uuid[]) and parent_grant_id is not null`,
        [[chain.middleId, chain.leafId]],
      ),
    ).toBe(2);
    const before = await grantCount();

    // Broader: an action the parent does not cover.
    const wider = await issue(chain.second, {
      subject: { kind: 'person', id: chain.leaf.personId },
      ...read('write'),
      parentGrantId: chain.middleId,
      grantedByActorId: chain.second.actorId,
    });
    expect(wider).toStrictEqual({
      ok: false,
      refusal: {
        code: 'GRANT_WIDENS',
        reason: 'the granter holds no live grant covering it',
        fix: 'narrow it',
      },
    });

    // Broader: passing on a grant that was never delegable.
    const passed = await issue(chain.leaf, {
      subject: { kind: 'person', id: chain.first.personId },
      ...read(),
      parentGrantId: chain.leafId,
      grantedByActorId: chain.leaf.actorId,
    });
    expect(passed).toStrictEqual({
      ok: false,
      refusal: {
        code: 'GRANT_WIDENS',
        reason: 'that grant may not be delegated',
        fix: 'ask for a delegable one',
      },
    });

    // Deeper: permitting delegation, which only a root grant may.
    const permits = await issue(chain.first, {
      subject: { kind: 'person', id: chain.leaf.personId },
      ...read(),
      canDelegate: true,
      mayPermitDelegation: true,
      parentGrantId: chain.rootId,
      grantedByActorId: chain.first.actorId,
    });
    expect(permits).toStrictEqual({
      ok: false,
      refusal: { code: 'GRANT_DEEPENS', reason: 'only a root grant may permit it', fix: 'drop it' },
    });

    // Deeper: a delegable grandchild from a middle that may not permit it.
    const onward = await issue(chain.second, {
      subject: { kind: 'person', id: chain.leaf.personId },
      ...read(),
      canDelegate: true,
      parentGrantId: chain.middleId,
      grantedByActorId: chain.second.actorId,
    });
    expect(onward).toStrictEqual({
      ok: false,
      refusal: {
        code: 'GRANT_DEEPENS',
        reason: 'the granter may not pass it on',
        fix: 'drop canDelegate',
      },
    });

    expect(await grantCount()).toBe(before);
  });

  it('revoking the root bites the grandchild on its very next call; the sibling chain reads on', async () => {
    const task = await c.createTask('a task two chains can read until one is revoked');
    const bitten = await buildChain('bitten');
    const sibling = await buildChain('sibling');

    for (const member of [bitten.leaf, bitten.second, sibling.leaf]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time; each counts its own audit row
      const { answer, trail } = await readAs(member, task.id);
      expect(answer.status).toBe(200);
      expect(JSON.stringify(answer.body)).toContain(task.id);
      expect(trail).toStrictEqual({ applied: 1, refused: 0 });
    }

    const revoked = await c.asPerson('grant.revoke', { grantId: bitten.rootId });
    expect(revoked.status).toBe(200);
    expect(detailOf(revoked)['grantId']).toBe(bitten.rootId);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'grant.revoke' and outcome = 'applied' and subject_record_id = $1`,
        [bitten.rootId],
      ),
    ).toBe(1);
    // Only the root row is stamped. The descendants lapse through `EFFECTIVE`.
    expect(
      await c.count(
        `select count(*)::text as n from public.grants
          where id = any($1::uuid[]) and revoked_at is null`,
        [[bitten.middleId, bitten.leafId, sibling.rootId, sibling.middleId, sibling.leafId]],
      ),
    ).toBe(5);

    for (const member of [bitten.leaf, bitten.second]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time; each counts its own audit row
      const { answer, trail } = await readAs(member, task.id);
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(answer.body)).not.toContain(task.id);
      expect(trail).toStrictEqual({ applied: 0, refused: 1 });
    }

    const control = await readAs(sibling.leaf, task.id);
    expect(control.answer.status).toBe(200);
    expect(JSON.stringify(control.answer.body)).toContain(task.id);
    expect(control.trail).toStrictEqual({ applied: 1, refused: 0 });
  });
});
