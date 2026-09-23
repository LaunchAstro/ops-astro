// SPDX-License-Identifier: AGPL-3.0-only
//
// Item 2: the role-and-case matrix, generated from the command surface.
//
// SPEC section 8 asks for six roles and nine cases against **every** declared
// operation, and for three properties: the enumeration is generated rather
// than hand-kept, every case runs against every endpoint, and a pass is zero
// successes outside the positive controls with every refusal typed. So every
// loop below iterates `COMMAND_SURFACE` itself and there is no list of
// operation names in this file. A declaration added elsewhere adds rows here;
// a declaration with no positive-control recipe throws rather than being
// skipped quietly.
//
// The apparatus is three files beside this one, split for T1h's reason — the
// per-file cap is 400 changed lines and the answer is to split the file, not
// the change and not the comments. `role-case-ledger.ts` is the rows and the
// file they are written to, `role-case-bodies.ts` the minimal valid body each
// declaration needs, `role-case-harness.ts` the world and the callers. What is
// left here is the cases and what each one claims.
//
// **The expected answers come from the product.** `refusal()` reads each
// status from `apps/api/status.ts`, and what an agent may reach is read from
// `AGENT_SURFACE` and `BEFORE_PICKUP` in `commands/agent-envelope.ts`. Nothing
// here writes a status literal beside a code: remembering the pairing is how a
// proof starts asserting the tester's belief rather than the product's.
//
// **A generated case that fails is recorded, not deleted.** Every observation
// lands in `.local/l5-matrix.tsv` with its verdict, and each case then asserts
// its own failing rows are empty — so a failure is in the file *and* in the
// run's exit code.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  declarationOf,
  pathOf,
  type CommandDeclaration,
} from '../../packages/core-records/src/commands/surface.ts';
import {
  AGENT_SURFACE,
  BEFORE_PICKUP,
} from '../../packages/core-records/src/commands/agent-envelope.ts';
import { bearer, call, personPath, serverUrl } from './world.ts';
import { SUCCESS, except, failures, observe, refusal, writeMatrix } from './role-case-ledger.ts';
import { createHarness, type Harness } from './role-case-harness.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/matrix: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('the role and case matrix, over every declaration', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness('mtx');
  }, 180_000);

  afterAll(async () => {
    writeMatrix();
    await harness?.close();
  });

  it('(a) succeeds for the admin on every declaration it can reach', async () => {
    // The positive control, and the reason the other cases mean anything: a
    // refusal proves nothing about authority if the same request would have
    // been refused for its shape, its revision, or a record that was not there.
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop -- one declaration at a time reads as a list
      const prepared = await harness.positiveBody(declaration);
      if ('exception' in prepared) {
        except('ada', 'a-permitted', declaration.name, prepared.exception);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asPerson(declaration.name, prepared.body);
      observe('ada', 'a-permitted', declaration.name, answer, SUCCESS);
    }
    expect(failures('a-permitted')).toStrictEqual([]);
  }, 180_000);

  it('(b) refuses the admin of one business on another business’s prefix', async () => {
    // `AUTH_NO_MEMBERSHIP`, and not a code that names the business: a login row
    // is tenant-scoped, so a member of alpha is simply unknown to bravo. A
    // caller who could tell "no such business" from "not your business" could
    // enumerate which businesses exist, which is what `app.ts`'s N7 note means
    // by the business being named in the path and verified rather than trusted.
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await call(
        harness.world.api,
        personPath('bravo', pathOf(declaration.name)),
        harness.probeBody(declaration),
        bearer(harness.world.ada.token),
      );
      observe('ada', 'b-foreign-business', declaration.name, answer, refusal('AUTH_NO_MEMBERSHIP'));
    }
    expect(failures('b-foreign-business')).toStrictEqual([]);
  }, 120_000);

  it('(c) and (d) answer a foreign record and a fabricated one identically', async () => {
    // The two halves of T1-N5. A caller who could tell them apart could probe
    // for another business's records one identifier at a time, so the claim is
    // not merely that both are `NOT_FOUND`: it is that the status, the code and
    // the whole body are the same bytes. The body comparison is the
    // load-bearing one — two answers can share a code and still differ in a
    // `details` array that names what was found.
    const targeted = COMMAND_SURFACE.filter(
      (declaration) => declaration.targetsExistingRecord || declaration.name === 'task.read',
    );
    expect(targeted.length).toBeGreaterThan(0);
    for (const declaration of targeted) {
      const shape = (recordId: string): Record<string, unknown> => ({
        ...harness.probeBody(declaration),
        recordId,
        // One operation identity per call, so neither answer is the register
        // replaying the other.
        operationId: randomUUID(),
      });
      // eslint-disable-next-line no-await-in-loop
      const foreign = await harness.asPerson(declaration.name, shape(harness.bravoRecordId));
      // eslint-disable-next-line no-await-in-loop
      const fabricated = await harness.asPerson(declaration.name, shape(randomUUID()));
      observe('ada', 'c-foreign-record', declaration.name, foreign, refusal('NOT_FOUND'));
      observe('ada', 'd-fabricated-id', declaration.name, fabricated, refusal('NOT_FOUND'));
      expect(foreign.status, declaration.name).toBe(fabricated.status);
      expect(foreign.body, declaration.name).toStrictEqual(fabricated.body);
    }
    expect(failures('c-foreign-record')).toStrictEqual([]);
    expect(failures('d-fabricated-id')).toStrictEqual([]);
  }, 120_000);

  it('(e) refuses every caller who holds nothing, and never answers empty', async () => {
    // Four roles in one sweep because they are one claim: a caller who may not
    // is told so, in words. What differs is *which* refusal, and that is
    // derived rather than listed — from the grants each person actually holds,
    // read back out of `grants` by the harness, so a fixture that changed what
    // it seeds changes what this expects instead of silently disagreeing.
    for (const caller of harness.otherCallers) {
      const grants = harness.heldBy.get(caller.name);
      for (const declaration of COMMAND_SURFACE) {
        const pair = harness.pairFor(declaration);
        if (grants !== undefined && grants.has(pair)) {
          // Held, so this caller's answer here is case (a)'s question and not
          // this one's. Recorded rather than dropped, so the matrix still has a
          // row for every role against every endpoint.
          except(caller.name, 'e-no-grant', declaration.name, `holds ${pair}; see case (a)`);
          continue;
        }
        if (declaration.name === 'session.capabilities' && grants !== undefined) {
          // The one declaration a member holding nothing may still reach, and
          // the reason is in the read itself: `reads/capabilities.ts:20`, "it
          // needs no grant beyond membership", because every pair in the
          // answer is a pair the caller already holds, so handing them back
          // confers nothing. The two refusals this case is really about are
          // untouched — `orphan` has no membership and never arrives here
          // (`AUTH_NO_MEMBERSHIP`, from the resolution, before any read), and
          // `bea` is in the other business and is refused as in case (b) —
          // because neither is in `heldBy` at all.
          //
          // So it is a named exception rather than a refusal, and it is
          // asserted rather than skipped: the 200 must carry the *caller's
          // own* grants. For `noah`, a member holding nothing, that is an
          // empty list — which is not the "nothing here" N2 forbids, because
          // it arrives as a 200 naming noah beside it rather than as silence
          // where a refusal was owed. The expected list is read back out of
          // `grants` by the harness, so a fixture that reseeded changes what
          // this expects instead of disagreeing with it.
          // eslint-disable-next-line no-await-in-loop
          const own = await call(
            harness.world.api,
            personPath('alpha', pathOf(declaration.name)),
            harness.probeBody(declaration),
            bearer(caller.token),
          );
          except(
            caller.name,
            'e-no-grant',
            declaration.name,
            `200 ok; needs no grant beyond membership (reads/capabilities.ts:20)`,
          );
          expect(own.status, caller.name).toBe(200);
          expect(own.body['refused'], `${caller.name}/${declaration.name}`).toBeUndefined();
          // The one shape, which case (h) asserts on the agent prefix too.
          expect(own.body['ok'], caller.name).toBe(true);
          expect(own.body['detail'], caller.name).toBeUndefined();
          expect(own.body['personId'], caller.name).toBe(caller.personId);
          const held = (own.body['grants'] as readonly { collection: string; action: string }[])
            .map((one) => `${one.collection}:${one.action}`)
            .toSorted();
          expect(held, caller.name).toStrictEqual([...grants].toSorted());
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const answer = await call(
          harness.world.api,
          personPath('alpha', pathOf(declaration.name)),
          harness.probeBody(declaration),
          bearer(caller.token),
        );
        // `orphan` has a verified login and no membership, and `bea` is a
        // member of the other business: neither reaches the grant model at all,
        // so their refusal is identity's rather than authority's. `noah` is a
        // member holding nothing, which is the one that must be
        // `SCOPE_NOT_GRANTED`.
        observe(
          caller.name,
          'e-no-grant',
          declaration.name,
          answer,
          refusal(grants === undefined ? 'AUTH_NO_MEMBERSHIP' : 'SCOPE_NOT_GRANTED'),
        );
        // The other half of N2, and the reason this case exists at all: a
        // refusal, never an empty list a caller would read as "nothing here".
        expect(answer.body['refused'], `${caller.name}/${declaration.name}`).toBe(true);
      }
    }
    expect(failures('e-no-grant')).toStrictEqual([]);
  }, 300_000);

  it('(f) refuses a read that succeeded once, after the grant is revoked', async () => {
    // I10, through the real authority boundary. The envelope asks
    // `effectiveGrants` inside the serving transaction, so a revocation bites
    // on the very next call rather than at the next login. Nothing here clears
    // a cache, because there is none to clear, and that absence is the property.
    const read = { recordId: harness.alphaTask.id };
    const mia = harness.world.mia;
    const before = await harness.asPerson('task.read', read, 'alpha', mia);
    observe('mia', 'f-revoked', 'task.read (before)', before, SUCCESS);

    // Taken back through the owning operation, `grant.revoke`, by the admin as
    // grant manager: the id is looked up, the revocation is the route. This is
    // also that declaration's positive control (`role-case-bodies.ts`).
    const held = await harness.world.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'read' and revoked_at is null`,
      [harness.world.alpha, mia.personId],
    );
    expect(held.length).toBeGreaterThan(0);
    for (const grant of held) {
      // eslint-disable-next-line no-await-in-loop
      const revoked = await harness.asPerson('grant.revoke', { grantId: grant.id });
      observe('ada', 'f-revoked', 'grant.revoke', revoked, SUCCESS);
    }
    // And the member cannot revoke it back or revoke anyone else's: `mia`
    // holds no `manage`, so the grant-manager gate refuses that caller first.
    const byMember = await harness.asPerson('grant.revoke', { grantId: held[0]?.id }, 'alpha', mia);
    observe('mia', 'f-revoked', 'grant.revoke', byMember, refusal('SCOPE_NOT_GRANTED'));

    const after = await harness.asPerson('task.read', read, 'alpha', mia);
    observe('mia', 'f-revoked', 'task.read (after)', after, refusal('SCOPE_NOT_GRANTED'));
    expect(failures('f-revoked')).toStrictEqual([]);
  }, 60_000);

  it('(h), (i), (j) and (g): the agent journey, generated over the whole table', async () => {
    const { subject, sibling, decided } = await harness.approvedReservation();
    // (j)'s control, taken first: the person who authorises the work is the one
    // who decides, and their decision succeeds. Without it, the agent's
    // exclusion below would only prove that this gate refuses everybody.
    observe('ada', 'j-decision-control', 'task.decide', decided, SUCCESS);
    const detail = decided.body['detail'] as Record<string, unknown>;
    const reservationId = String(detail['reservationId']);

    // (h) I12, over every declaration, with the expectation derived from the
    // two exported sets rather than from a list here. Three answers, and the
    // middle one is the part SPEC's wording does not cover: an operation
    // outside `AGENT_SURFACE` is `DELEGATION_EXCLUDES_OPERATION` and not
    // `DELEGATION_NOT_LIVE`, because it would not be an agent's to call even
    // holding a live credential. Both are typed refusals; they are different
    // sentences, and this asserts the one the product actually says.
    for (const declaration of COMMAND_SURFACE) {
      if (declaration.name === 'task.pickup') continue;
      if (declaration.name === 'session.capabilities') {
        // The third thing an agent may do before a pickup, and the reason it
        // is not in `BEFORE_PICKUP` is deliberate: that set is the *ceiling
        // the refusal message quotes*, and an agent reading its own
        // capabilities should be told the two operations it may do, not three
        // (`agent-envelope.ts:98-107`). So the declaration is reachable while
        // the set stays at two, and the matrix records that as an exception
        // with the reason rather than as a `DELEGATION_NOT_LIVE` it would
        // have to be wrong about.
        //
        // Asserted, not waved through. Before a pickup there is no delegation
        // to be bounded by, so `purposeScope` must be null; and the `grants`
        // it reports must be exactly the pairs `BEFORE_PICKUP`'s two
        // operations take, read from their own declarations, so widening that
        // set without widening this answer fails here.
        // eslint-disable-next-line no-await-in-loop
        const own = await harness.asAgent(declaration.name, harness.probeBody(declaration));
        except(
          'agent-before-pickup',
          'h-pre-pickup',
          declaration.name,
          '200 ok; reachable before a pickup, kept out of BEFORE_PICKUP so the ' +
            'refusal quotes two operations (agent-envelope.ts:98-107)',
        );
        expect(own.status, declaration.name).toBe(200);
        expect(own.body['refused'], declaration.name).toBeUndefined();
        // One shape on both prefixes: flattened beside `ok`, as case (e) asserts
        // on the person prefix. It used to be nested under `detail` here, where
        // the other agent answers' payloads go, so a client had to know which
        // prefix it was on to read one read.
        expect(own.body['ok'], declaration.name).toBe(true);
        expect(own.body['detail'], declaration.name).toBeUndefined();
        const beforeAny = own.body;
        expect(beforeAny['agentActorId'], declaration.name).toBeTypeOf('string');
        expect(beforeAny['purposeScope'], declaration.name).toBeNull();
        const reported = (beforeAny['grants'] as readonly { collection: string; action: string }[])
          .map((one) => `${one.collection}:${one.action}`)
          .toSorted();
        const owed = [...BEFORE_PICKUP]
          .map((name) => harness.pairFor(declarationOf(name) as CommandDeclaration))
          .toSorted();
        expect(BEFORE_PICKUP.size, 'BEFORE_PICKUP is the two-operation ceiling').toBe(2);
        expect(reported, declaration.name).toStrictEqual([...new Set(owed)]);
        continue;
      }
      const expected = BEFORE_PICKUP.has(declaration.name)
        ? SUCCESS
        : refusal(
            AGENT_SURFACE.has(declaration.name)
              ? 'DELEGATION_NOT_LIVE'
              : 'DELEGATION_EXCLUDES_OPERATION',
          );
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asAgent(declaration.name, harness.probeBody(declaration));
      observe('agent-before-pickup', 'h-pre-pickup', declaration.name, answer, expected);
    }

    const pickedUp = await harness.asAgent('task.pickup', { reservationId });
    observe('agent-before-pickup', 'h-pre-pickup', 'task.pickup', pickedUp, SUCCESS);
    const picked = pickedUp.body['detail'] as Record<string, unknown>;
    const credential = String(picked['credential']);
    expect(picked['taskId']).toBe(subject.id);

    // (i) I07's one-task ceiling. The sibling is really there and the agent may
    // really not reach it, so `DELEGATION_OUT_OF_PURPOSE` and never
    // `NOT_FOUND`: the second would tell a probing agent the task does not
    // exist, which is false, and would make the ceiling indistinguishable from
    // a typo. The delegating person on the same sibling is the control.
    const outside = await harness.asAgent('task.read', { recordId: sibling.id }, credential);
    const outOfPurpose = refusal('DELEGATION_OUT_OF_PURPOSE');
    observe('agent-after-pickup', 'i-out-of-purpose', 'task.read', outside, outOfPurpose);
    const onSibling = await harness.asPerson('task.read', { recordId: sibling.id });
    observe('ada', 'i-out-of-purpose', 'task.read (control)', onSibling, SUCCESS);
    const inside = await harness.asAgent('task.read', { recordId: subject.id }, credential);
    observe('agent-after-pickup', 'i-inside-ceiling', 'task.read', inside, SUCCESS);

    // (i) again, generated over the whole table rather than over one read. Each
    // declaration is called under the live credential naming the **sibling**,
    // and what the product should answer is derived rather than listed: a
    // decision is excluded before the purpose is read, an operation outside
    // `AGENT_SURFACE` is not an agent's to call whatever its purpose, and
    // everything left is the one-task ceiling.
    const table = 'i-after-pickup-table';
    for (const declaration of COMMAND_SURFACE) {
      if (BEFORE_PICKUP.has(declaration.name)) {
        // The queue and a pickup are reachable with no delegation at all, so a
        // delegation cannot narrow them, and a second pickup would claim state
        // the rest of this case depends on. Case (h) is where they are proved.
        except('agent-after-pickup', table, declaration.name, 'see case (h)');
        continue;
      }
      if (declaration.name === 'session.capabilities') {
        // The same reason the queue and a pickup are excepted above, arrived
        // at from the other end: this read is reachable with no delegation at
        // all, so a delegation cannot narrow it. What it *does* change after a
        // pickup is its own answer — `purposeScope` is now the picked-up task
        // — and that is the ceiling itself reported, not a call the ceiling
        // could refuse. Asserted here so the shift from null is seen once.
        // eslint-disable-next-line no-await-in-loop
        const own = await harness.asAgent(
          declaration.name,
          harness.probeBody(declaration),
          credential,
        );
        except(
          'agent-after-pickup',
          table,
          declaration.name,
          'reachable with no delegation; its answer is the purpose, not a call under it',
        );
        expect(own.status, declaration.name).toBe(200);
        expect(own.body['ok'], declaration.name).toBe(true);
        const after = own.body;
        expect(after['purposeScope'], declaration.name).toStrictEqual({
          kind: 'record',
          id: subject.id,
        });
        continue;
      }
      if (declaration.name === 'task.handback') {
        // A handback names a lease, not a record, and `subjectTaskId` resolves
        // its task through that lease precisely so an agent cannot name its own
        // task while settling somebody else's. A fabricated lease resolves to
        // nothing and falls back to this delegation's own scope, so the call is
        // *inside* the purpose by construction and proves nothing about the
        // ceiling. Recorded rather than dressed up as a refusal it is not.
        except('agent-after-pickup', table, declaration.name, 'its task comes from the lease');
        continue;
      }
      const expected = refusal(
        declaration.name === 'task.decide'
          ? 'DELEGATION_EXCLUDES_DECISION'
          : AGENT_SURFACE.has(declaration.name)
            ? 'DELEGATION_OUT_OF_PURPOSE'
            : 'DELEGATION_EXCLUDES_OPERATION',
      );
      // eslint-disable-next-line no-await-in-loop
      const answer = await harness.asAgent(
        declaration.name,
        { ...harness.probeBody(declaration), recordId: sibling.id },
        credential,
      );
      observe('agent-after-pickup', table, declaration.name, answer, expected);
    }

    // The agent's own task, with an action its delegation carries. `comment` is
    // one of the three `pickup` mints and `task.comment` is in `AGENT_SURFACE`,
    // so it succeeds with a saved comment identity (SPEC-ADJUDICATE (a),
    // contract ledger `task.comment`: "comment grant and permitted audience;
    // current delegation if agent"). The permitted audience is the team's:
    // a client-visible comment stays a person's to write.
    const agentComments = await harness.asAgent(
      'task.comment',
      { recordId: subject.id, body: 'the agent writes a note', audience: 'internal' },
      credential,
    );
    observe('agent-after-pickup', table, 'task.comment (own task)', agentComments, SUCCESS);
    const saved = (agentComments.body['detail'] as Record<string, unknown> | undefined)?.[
      'commentId'
    ];
    expect(String(saved)).toMatch(/^[0-9a-f-]{36}$/u);
    const toClient = await harness.asAgent(
      'task.comment',
      { recordId: subject.id, body: 'the agent writes to the client', audience: 'client' },
      credential,
    );
    const notPermitted = refusal('AUDIENCE_NOT_PERMITTED');
    observe('agent-after-pickup', table, 'task.comment (client)', toClient, notPermitted);

    // The lease owner's heartbeat on its own lease, and the same call at a
    // fence that is not the lease's, which is somebody else's claim.
    const beat = await harness.asAgent(
      'task.heartbeat',
      { leaseId: picked['leaseId'], fence: picked['fence'] },
      credential,
    );
    observe('agent-after-pickup', table, 'task.heartbeat (own lease)', beat, SUCCESS);
    const stale = await harness.asAgent(
      'task.heartbeat',
      { leaseId: picked['leaseId'], fence: Number(picked['fence']) + 1 },
      credential,
    );
    observe(
      'agent-after-pickup',
      table,
      'task.heartbeat (stale)',
      stale,
      refusal('LEASE_NOT_OWNED'),
    );

    // (j) The decision, excluded from every delegation and checked first in the
    // order so it is never reported as something else, beside the person's own
    // successful decision recorded at the top of this case.
    const agentDecides = await harness.asAgent(
      'task.decide',
      { gateId: randomUUID(), versionId: randomUUID(), decision: 'approve', note: 'not mine' },
      credential,
    );
    const noDecision = refusal('DELEGATION_EXCLUDES_DECISION');
    observe('agent-after-pickup', 'j-decision-excluded', 'task.decide', agentDecides, noDecision);

    // (g) I09. No external *party* reader can be minted through this seed's
    // shape — `tests/identity/fixture.ts` writes every membership with
    // `role_key = 'member'`, and `reads/tasks.ts` counts owner, admin and
    // member as internal — so that gap is recorded as a fact rather than worked
    // around with an identity the product does not have. What the API *can*
    // mint is the other external reader: an agent is not a member, and
    // `agent-envelope.ts` reads its own task with `internal: false`, which is
    // `externalCommentProjection`. So the allowlist is proved through the
    // reader that exists, and the one that does not is named.
    expect(await harness.activeRoleKeys()).toStrictEqual(['member']);
    except(
      'external-party',
      'g-external-projection',
      'task.read',
      'no non-member role in the seed',
    );

    for (const written of await harness.writeBothComments(subject.id)) {
      expect(written.code).toBe('ok');
    }
    const agentRead = await harness.asAgent('task.read', { recordId: subject.id }, credential);
    observe('agent-after-pickup', 'g-external-projection', 'task.read', agentRead, SUCCESS);
    const task = (agentRead.body['detail'] as Record<string, unknown>)['task'] as Record<
      string,
      unknown
    >;
    const comments = task['comments'] as readonly Record<string, unknown>[];
    // Absent, not hidden. The internal note is in no field of the body, which
    // is the direction of I09 that a `visible: false` flag would fail.
    expect(JSON.stringify(comments)).not.toContain('must never see');
    expect(comments).toHaveLength(1);

    // (i) I08, the second half. The delegation stores no permission, so taking
    // the delegating person's grant away collapses the agent on its next call —
    // and it is `DELEGATION_NARROWED` by name, because substituting
    // `SCOPE_NOT_GRANTED` would say the agent was never authorised when what
    // happened is that the authority it draws on was withdrawn.
    // Withdrawn through the owning operation: the admin, as grant manager,
    // revokes its own task read with `grant.revoke`, so the narrowing is
    // produced by a route rather than by a direct write.
    const adaReads = await harness.world.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'read' and revoked_at is null`,
      [harness.world.alpha, harness.world.ada.personId],
    );
    expect(adaReads.length).toBeGreaterThan(0);
    for (const grant of adaReads) {
      // eslint-disable-next-line no-await-in-loop
      const revoked = await harness.asPerson('grant.revoke', { grantId: grant.id });
      observe('ada', 'i-narrowed', 'grant.revoke (own read)', revoked, SUCCESS);
    }
    const narrowed = await harness.asAgent('task.read', { recordId: subject.id }, credential);
    const wasNarrowed = refusal('DELEGATION_NARROWED');
    observe('agent-after-pickup', 'i-narrowed', 'task.read', narrowed, wasNarrowed);

    for (const kase of [
      'h-pre-pickup',
      'i-out-of-purpose',
      'i-inside-ceiling',
      table,
      'i-narrowed',
      'j-decision-control',
      'j-decision-excluded',
      'g-external-projection',
    ]) {
      expect(failures(kase), kase).toStrictEqual([]);
    }
  }, 300_000);
});
