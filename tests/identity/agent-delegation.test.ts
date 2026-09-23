// SPDX-License-Identifier: AGPL-3.0-only
//
// I01 R5, I07 and I08: the agent signs in as itself, acts inside a purpose,
// and is narrowed by the delegating person's live grants on every call.
//
// The three failures this guards against, in the order the ledger names them.
// An agent borrowing a person's credential and resolving as that person. A
// delegated agent deciding. And a delegation that keeps working after the
// person's grant is revoked, because the permission was copied at mint time
// instead of intersected at call time.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  mintDelegation,
  resolveDelegation,
  revokeDelegation,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { resolveAgentLogin } from '../../packages/core-records/src/identity/agent-login.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const COLLECTION = 'task';
const PURPOSE = 'task_work';

describe.skipIf(serverUrl === undefined)('the agent, its login and its delegation', () => {
  let db: FreshDatabase;
  let taskA: string;
  let taskB: string;
  let business: string;
  let adaPerson: string;
  let adaActor: string;
  let agentActor: string;
  let rootGrant: string;
  let credential: string;
  let delegationId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      adaPerson = await insertPerson(tx, 'Ada');
      adaActor = await insertActor(tx, adaPerson);
      await insertMembership(tx, adaPerson);
      const adaLogin = await insertLogin(tx, 'ada-subject');
      await insertMapping(tx, adaLogin, adaPerson, adaActor);

      agentActor = await insertAgentActor(tx);
      const agentLogin = await insertLogin(tx, 'agent-subject');
      await insertAgentMapping(tx, agentLogin, agentActor, adaActor);

      // Two root grants, because the purpose below asks for both and a
      // delegation is refused at mint time for anything its person does not
      // hold. The write one is the grant I08 revokes.
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const issued = await issueGrant(tx, [{ kind: 'person', id: adaPerson }], {
          subject: { kind: 'person', id: adaPerson },
          scope: { kind: 'business', id: null },
          collection: COLLECTION,
          action,
          parentGrantId: null,
          grantedByActorId: adaActor,
        });
        if (!issued.ok) {
          throw new Error(`fixture: the ${action} grant was refused ${issued.refusal.code}`);
        }
        if (action === 'write') rootGrant = issued.value;
      }

      // Two sibling tasks of the same type. The delegation is minted for the
      // first; the second is what the one-task ceiling has to refuse, and it
      // has to be a real record rather than a spare uuid so the refusal is
      // about the purpose rather than about a row that is not there.
      const spine = await installTaskSpine(tx);
      taskA = randomUUID();
      taskB = randomUUID();
      for (const [id, title] of [
        [taskA, 'the picked-up task'],
        [taskB, 'its sibling'],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [business, id, spine.taskTypeId, { title }],
        );
      }

      const minted = await mintDelegation(tx, {
        agentActorId: agentActor,
        delegatePersonId: adaPerson,
        mintedByActorId: adaActor,
        purpose: PURPOSE,
        collections: [COLLECTION],
        actions: ['read', 'write'],
        purposeScope: { kind: 'record', id: taskA },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`fixture: the mint was refused ${minted.refusal.code}`);
      credential = minted.value.credential;
      delegationId = minted.value.delegation.id;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const liveDelegation = async (): Promise<Delegation> =>
    await db.app.withBusiness(business, async (tx) => {
      const resolved = await resolveDelegation(tx, agentActor, credential);
      if (!resolved.ok) throw new Error(`the delegation did not resolve: ${resolved.refusal.code}`);
      return resolved.value;
    });

  describe('the agent login is its own', () => {
    it('resolves the agent credential to the agent actor and to no person', async () => {
      const session = await db.app.withBusiness(business, async (tx) =>
        resolveAgentLogin(tx, { provider: 'supabase', subject: 'agent-subject' }),
      );
      expect('refused' in session).toBe(false);
      if ('refused' in session) return;
      expect(session.actorId).toBe(agentActor);
      expect(session.kind).toBe('agent');
      expect(Object.hasOwn(session, 'personId')).toBe(false);
    });

    it('refuses the agent subject on the person login path', async () => {
      const person = await db.app.withBusiness(business, async (tx) =>
        resolveLogin(tx, { provider: 'supabase', subject: 'agent-subject' }),
      );
      expect('refused' in person && person.code).toBe('AUTH_NO_MEMBERSHIP');
    });

    it("refuses a person's subject on the agent login path, in the same words", async () => {
      const agent = await db.app.withBusiness(business, async (tx) =>
        resolveAgentLogin(tx, { provider: 'supabase', subject: 'ada-subject' }),
      );
      const unknown = await db.app.withBusiness(business, async (tx) =>
        resolveAgentLogin(tx, { provider: 'supabase', subject: randomUUID() }),
      );
      expect('refused' in agent && agent.code).toBe('AUTH_NO_AGENT_IDENTITY');
      expect(agent).toStrictEqual(unknown);
    });
  });

  describe('the purpose', () => {
    it('permits a call the purpose names and the person holds', async () => {
      const delegation = await liveDelegation();
      const decision = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'write',
          scope: { kind: 'record', id: taskA },
        }),
      );
      expect(decision.ok).toBe(true);
    });

    it('refuses a collection the purpose does not name, before reading a grant', async () => {
      const delegation = await liveDelegation();
      const decision = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: 'invoice',
          action: 'write',
          scope: { kind: 'record', id: taskA },
        }),
      );
      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    });
  });

  describe('I07: the decision is excluded', () => {
    it('refuses a decision on its own ground, not as an ungranted scope', async () => {
      const delegation = await liveDelegation();
      const decision = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'decide',
          scope: { kind: 'record', id: taskA },
        }),
      );
      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.refusal.code).toBe('DELEGATION_EXCLUDES_DECISION');
      expect(decision.refusal.code).not.toBe('SCOPE_NOT_GRANTED');
    });

    it('cannot be written into a delegation at all', async () => {
      const minted = await db.app.withBusiness(business, async (tx) =>
        mintDelegation(tx, {
          agentActorId: agentActor,
          delegatePersonId: adaPerson,
          mintedByActorId: adaActor,
          purpose: 'deciding',
          collections: [COLLECTION],
          actions: ['decide'],
          purposeScope: { kind: 'record', id: taskA },
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );
      expect(minted.ok).toBe(false);
      if (minted.ok) return;
      expect(minted.refusal.code).toBe('DELEGATION_EXCLUDES_DECISION');
    });
  });

  describe('I08: the narrowing collapses on the next call', () => {
    it('narrows by name when the underlying person grant is revoked', async () => {
      const delegation = await liveDelegation();
      const before = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'write',
          scope: { kind: 'record', id: taskA },
        }),
      );
      expect(before.ok).toBe(true);

      await db.app.withBusiness(business, async (tx) => {
        await revokeGrant(tx, rootGrant);
      });

      // The same delegation row, unrevoked and unexpired, re-read from the
      // database: nothing about the credential changed.
      const after = await db.app.withBusiness(business, async (tx) => {
        const live = await resolveDelegation(tx, agentActor, credential);
        if (!live.ok) throw new Error(`the delegation stopped resolving: ${live.refusal.code}`);
        return await checkDelegatedAuthority(tx, live.value, {
          collection: COLLECTION,
          action: 'write',
          scope: { kind: 'record', id: taskA },
        });
      });
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.refusal.code).toBe('DELEGATION_NARROWED');
      expect(after.refusal.code).not.toBe('SCOPE_NOT_GRANTED');
      expect(after.refusal.reason).toContain('grant');
    });

    it('stops resolving once the delegation itself is revoked', async () => {
      await db.app.withBusiness(business, async (tx) => {
        await revokeDelegation(tx, delegationId);
      });
      const resolved = await db.app.withBusiness(business, async (tx) =>
        resolveDelegation(tx, agentActor, credential),
      );
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.refusal.code).toBe('DELEGATION_NOT_LIVE');
    });
  });

  // Finding 4: the purpose is a ceiling on *what*, not only on collections and
  // actions. R1's grant is business-wide, so without the stored purpose scope a
  // call on a sibling task reaches that same grant and passes exactly as a call
  // on the picked-up task does -- the helper cannot tell them apart.
  describe('the one-task purpose ceiling', () => {
    it('permits the picked-up task, and refuses its sibling and the whole business', async () => {
      // Its own delegation, on the `read` grant the cases above leave alone, so
      // this says something about the ceiling rather than about their order.
      const delegation = await db.app.withBusiness(business, async (tx) => {
        const minted = await mintDelegation(tx, {
          agentActorId: agentActor,
          delegatePersonId: adaPerson,
          mintedByActorId: adaActor,
          purpose: 'one_task_ceiling',
          collections: [COLLECTION],
          actions: ['read'],
          purposeScope: { kind: 'record', id: taskA },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        if (!minted.ok) throw new Error(`the mint was refused ${minted.refusal.code}`);
        return minted.value.delegation;
      });
      expect(delegation.purposeScope).toStrictEqual({ kind: 'record', id: taskA });

      const onTaskA = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'read',
          scope: { kind: 'record', id: taskA },
        }),
      );
      expect(onTaskA.ok).toBe(true);

      // The same call, the same grant, a different task.
      const onTaskB = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'read',
          scope: { kind: 'record', id: taskB },
        }),
      );
      expect(onTaskB.ok).toBe(false);
      if (onTaskB.ok) return;
      expect(onTaskB.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');
      expect(onTaskB.refusal.code).not.toBe('SCOPE_NOT_GRANTED');

      // And the business-wide request the person's own grant would satisfy.
      const wide = await db.app.withBusiness(business, async (tx) =>
        checkDelegatedAuthority(tx, delegation, {
          collection: COLLECTION,
          action: 'read',
          scope: { kind: 'business', id: null },
        }),
      );
      expect(wide.ok).toBe(false);
      if (wide.ok) return;
      expect(wide.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    });
  });
});
