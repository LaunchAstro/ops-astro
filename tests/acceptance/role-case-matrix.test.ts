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
import { COMMAND_SURFACE, pathOf } from '../../packages/core-records/src/commands/surface.ts';
import {
  AGENT_SURFACE,
  BEFORE_PICKUP,
} from '../../packages/core-records/src/commands/agent-envelope.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { bearer, call, enrolExternal, personPath, serverUrl } from './world.ts';
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
          // Held, so this caller is not R2 for this operation: the minimum
          // contract's R2 is a member *without* that grant (CONTRACT.md:481)
          // and case 3 is R2 against every endpoint (CONTRACT.md:493). A
          // refusal manufactured for a caller who holds the grant would be a
          // wrong answer, not a stricter test. So the cell is not applicable,
          // and it says where the two real rows are: `noah`, who holds
          // nothing, is refused on this operation above, and this caller's own
          // success is the next case's positive control.
          except(
            caller.name,
            'e-no-grant',
            declaration.name,
            `not applicable: holds ${pair}, so not R2 (minimum contract CONTRACT.md:481, ` +
              `case 3 at :493); noah is refused here; own row in e-member-positive`,
          );
          continue;
        }
        if (declaration.name === 'session.capabilities' && grants !== undefined) {
          // The read with no collection of its own: it reports the caller's
          // grants, so the grant it takes is holding one at all. `noah`, a
          // member holding nothing, is R2 for it and is refused
          // `SCOPE_NOT_GRANTED` like everywhere else (contract 8.2 case 3,
          // ledger I05), never a 200 with an empty list. `mia` holds grants,
          // so she is not R2 here and her row is the control: a 200 carrying
          // her own pairs, read back out of `grants` by the harness.
          // `orphan` and `bea` are not in `heldBy` and fall through below.
          // eslint-disable-next-line no-await-in-loop
          const own = await call(
            harness.world.api,
            personPath('alpha', pathOf(declaration.name)),
            harness.probeBody(declaration),
            bearer(caller.token),
          );
          if (grants.size === 0) {
            observe(caller.name, 'e-no-grant', declaration.name, own, refusal('SCOPE_NOT_GRANTED'));
            expect(own.body['refused'], `${caller.name}/${declaration.name}`).toBe(true);
            expect(own.body['grants'], caller.name).toBeUndefined();
            continue;
          }
          observe(caller.name, 'e-no-grant', declaration.name, own, SUCCESS);
          // The one shape, which case (i) asserts on the agent prefix too.
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

  it('(e) and its control: a member succeeds on every operation it holds', async () => {
    // The other half of case (e), and the reason it means anything for a
    // member who holds grants: every pair such a caller holds is driven with
    // the same minimal valid body case (a) gives the admin, set up by the
    // admin and sent by the member. Derived from `heldBy`, so a reseed that
    // widened or narrowed a member's grants changes the rows rather than
    // disagreeing with them. Runs before (f), which takes `mia`'s read away.
    // Person work (EX-01) is a sequence on the member's own lease rather than
    // three independent bodies: the member picks up approved work as
    // themselves, renews that lease and hands it back. It is driven once per
    // member, when the first of the three comes up in the surface's order.
    const personWork = new Set(['task.pickup', 'task.heartbeat', 'task.handback']);
    const drivenFor = new Set<string>();
    const pairOf = (name: string): string => {
      const declaration = COMMAND_SURFACE.find((each) => each.name === name);
      if (declaration === undefined) throw new Error(`matrix: no declaration ${name}`);
      return harness.pairFor(declaration);
    };
    async function driveOwnLease(
      caller: (typeof harness.otherCallers)[number],
      grants: ReadonlySet<string>,
    ): Promise<void> {
      if (drivenFor.has(caller.name)) return;
      drivenFor.add(caller.name);
      if (!grants.has(pairOf('task.pickup'))) return;
      const pickupDeclaration = COMMAND_SURFACE.find((each) => each.name === 'task.pickup');
      if (pickupDeclaration === undefined) throw new Error('matrix: no task.pickup');
      const prepared = await harness.positiveBody(pickupDeclaration);
      if ('exception' in prepared) throw new Error('matrix: task.pickup has no body');
      const picked = await harness.asPerson('task.pickup', prepared.body, 'alpha', caller);
      observe(caller.name, 'e-member-positive', 'task.pickup', picked, SUCCESS);
      const lease = (picked.body['detail'] as Record<string, unknown> | undefined) ?? {};
      const own = { leaseId: lease['leaseId'], fence: lease['fence'] };
      if (grants.has(pairOf('task.heartbeat'))) {
        const beat = await harness.asPerson('task.heartbeat', own, 'alpha', caller);
        observe(caller.name, 'e-member-positive', 'task.heartbeat', beat, SUCCESS);
      }
      if (grants.has(pairOf('task.handback'))) {
        const settled = await harness.asPerson(
          'task.handback',
          { ...own, outcome: 'completed' },
          'alpha',
          caller,
        );
        observe(caller.name, 'e-member-positive', 'task.handback', settled, SUCCESS);
      }
    }
    for (const caller of harness.otherCallers) {
      const grants = harness.heldBy.get(caller.name);
      if (grants === undefined) continue;
      for (const declaration of COMMAND_SURFACE) {
        if (!grants.has(harness.pairFor(declaration))) continue;
        if (personWork.has(declaration.name)) {
          // eslint-disable-next-line no-await-in-loop
          await driveOwnLease(caller, grants);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const prepared = await harness.positiveBody(declaration);
        if ('exception' in prepared) throw new Error(`matrix: ${declaration.name} has no body`);
        // eslint-disable-next-line no-await-in-loop
        const answer = await harness.asPerson(declaration.name, prepared.body, 'alpha', caller);
        observe(caller.name, 'e-member-positive', declaration.name, answer, SUCCESS);
      }
    }
    expect(failures('e-member-positive')).toStrictEqual([]);
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
    // exported `BEFORE_PICKUP` rather than from a list here. Three answers, as
    // minimum contract 8.2 case 9 names them: the queue and a pickup succeed,
    // `task.decide` is `DELEGATION_EXCLUDES_DECISION`, and every other
    // operation, the agent's own after a pickup included, is
    // `DELEGATION_EXCLUDES_OPERATION`.
    for (const declaration of COMMAND_SURFACE) {
      if (declaration.name === 'task.pickup') continue;
      // `session.capabilities` is one of the refused: before a pickup the
      // login reaches the two operations in `BEFORE_PICKUP` and nothing else,
      // and `task.decide` is refused as a decision (contract 8.2 case 9).
      const expected = BEFORE_PICKUP.has(declaration.name)
        ? SUCCESS
        : refusal(
            declaration.name === 'task.decide'
              ? 'DELEGATION_EXCLUDES_DECISION'
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

    // A second live delegation, on the sibling and for another purpose, so the
    // handback row below has a real lease outside this credential's purpose to
    // name. One agent may hold one live delegation per purpose
    // (`DELEGATION_ALREADY_LIVE`), so a second purpose is a second pickup by
    // the same login rather than a second agent.
    const siblingDecided = await harness.reserve(sibling, 'draft_the_sibling_reply');
    observe('ada', 'k-handback', 'task.decide (sibling)', siblingDecided, SUCCESS);
    const siblingReservation = (siblingDecided.body['detail'] as Record<string, unknown>)[
      'reservationId'
    ];
    const siblingPickup = await harness.asAgent('task.pickup', {
      reservationId: siblingReservation,
    });
    observe('agent-before-pickup', 'k-handback', 'task.pickup (sibling)', siblingPickup, SUCCESS);
    const siblingLease = siblingPickup.body['detail'] as Record<string, unknown>;
    expect(siblingLease['taskId']).toBe(sibling.id);

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
        except(
          'agent-after-pickup',
          table,
          declaration.name,
          'executed alternative: needs no delegation, success asserted in case (h) (ledger I12)',
        );
        continue;
      }
      if (declaration.name === 'session.capabilities') {
        // Under the live delegation this read answers, and what a pickup
        // changes is its own answer: `purposeScope` is now the picked-up task,
        // the ceiling itself reported. Before the pickup it was refused, in
        // case (h).
        // eslint-disable-next-line no-await-in-loop
        const own = await harness.asAgent(
          declaration.name,
          harness.probeBody(declaration),
          credential,
        );
        observe('agent-after-pickup', table, declaration.name, own, SUCCESS);
        // One shape on both prefixes: flattened beside `ok`, as case (e)
        // asserts on the person prefix.
        expect(own.body['ok'], declaration.name).toBe(true);
        expect(own.body['detail'], declaration.name).toBeUndefined();
        const after = own.body;
        expect(after['agentActorId'], declaration.name).toBeTypeOf('string');
        expect(after['purposeScope'], declaration.name).toStrictEqual({
          kind: 'record',
          id: subject.id,
        });
        // EX-35 (root ruling 5): the current intersection of the pickup's
        // purpose and the delegating person's effective grants on the task,
        // never the pre-pickup pair and never a pair outside the purpose. The
        // person here holds what the purpose carries, so it is all of it.
        const reported = (after['grants'] as readonly { collection: string; action: string }[])
          .map((one) => `${one.collection}:${one.action}`)
          .toSorted();
        expect(reported, declaration.name).toStrictEqual([
          'task:comment',
          'task:read',
          'task:write',
        ]);
        continue;
      }
      if (declaration.name === 'task.handback') {
        // A handback names a lease, not a record, and `subjectTaskId` resolves
        // its task through that lease (`agent-envelope.ts:363-378`) so an agent
        // cannot name its own task while settling somebody else's. So the
        // sibling is reached the only way a handback can reach it: by naming
        // the lease the *other* delegation holds on it, at that lease's own
        // fence. The lease's task is the sibling, which is outside this
        // credential's purpose, so `DELEGATION_OUT_OF_PURPOSE` before any
        // handback write: no report is retained and the lease is still live.
        // eslint-disable-next-line no-await-in-loop
        const answer = await harness.asAgent(
          declaration.name,
          { leaseId: siblingLease['leaseId'], fence: siblingLease['fence'], outcome: 'completed' },
          credential,
        );
        observe(
          'agent-after-pickup',
          table,
          declaration.name,
          answer,
          refusal('DELEGATION_OUT_OF_PURPOSE'),
        );
        // eslint-disable-next-line no-await-in-loop
        const untouched = await harness.world.db.admin.execute<{ readonly n: string }>(
          `select (select count(*) from public.handback_reports where lease_id = $1)::text as n`,
          [siblingLease['leaseId']],
        );
        expect(untouched[0]?.n, 'no report for a lease outside the purpose').toBe('0');
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

    // (k) The operations the admin's positive control could not reach from the
    // person path, driven for real on the sibling delegation now that the table
    // is done with it. First the handback: the person path is refused by design
    // even for the admin, and the lease holder's own handback settles it.
    // A person naming the agent's lease is refused and writes nothing: the
    // agent's own handback below still settles it. A person hands back only a
    // lease their own pickup took (EX-01), so the answer is not-owned.
    const byPerson = await harness.asPerson('task.handback', {
      leaseId: siblingLease['leaseId'],
      fence: siblingLease['fence'],
      outcome: 'completed',
    });
    expect(byPerson.body['refused'], 'a person does not settle an agent lease').toBe(true);
    expect(byPerson.body['code']).toBe('LEASE_NOT_OWNED');
    const siblingCredential = String(siblingLease['credential']);
    const handedBack = await harness.asAgent(
      'task.handback',
      { leaseId: siblingLease['leaseId'], fence: siblingLease['fence'], outcome: 'completed' },
      siblingCredential,
    );
    observe('agent-after-pickup', 'k-handback', 'task.handback (own lease)', handedBack, SUCCESS);
    const settled = handedBack.body['detail'] as Record<string, unknown>;
    expect(settled['reservationId']).toBe(siblingReservation);
    // Settled: the handed-back credential is no longer a live delegation.
    const afterHandback = await harness.asAgent(
      'task.read',
      { recordId: sibling.id },
      siblingCredential,
    );
    const notLive = refusal('DELEGATION_NOT_LIVE');
    observe('agent-after-pickup', 'k-handback', 'task.read (settled)', afterHandback, notLive);

    // Then the revocation, through `delegation.revoke` by the admin, on a third
    // live delegation made for the purpose: the journey's own credential is
    // still needed below. The member who holds no `manage` is refused first.
    const revokable = await harness.freshTask('a task whose delegation is revoked');
    const revokeDecided = await harness.reserve(revokable, 'draft_the_revoked_reply');
    const revokePickup = await harness.asAgent('task.pickup', {
      reservationId: (revokeDecided.body['detail'] as Record<string, unknown>)['reservationId'],
    });
    observe('agent-before-pickup', 'k-revoke', 'task.pickup', revokePickup, SUCCESS);
    const toRevoke = revokePickup.body['detail'] as Record<string, unknown>;
    const revokedCredential = String(toRevoke['credential']);
    const liveRead = await harness.asAgent(
      'task.read',
      { recordId: revokable.id },
      revokedCredential,
    );
    observe('agent-after-pickup', 'k-revoke', 'task.read (before)', liveRead, SUCCESS);
    const noManage = await harness.asPerson(
      'delegation.revoke',
      { delegationId: toRevoke['delegationId'] },
      'alpha',
      harness.world.noah,
    );
    observe('noah', 'k-revoke', 'delegation.revoke', noManage, refusal('SCOPE_NOT_GRANTED'));
    const revokedDelegation = await harness.asPerson('delegation.revoke', {
      delegationId: toRevoke['delegationId'],
    });
    observe('ada', 'k-revoke', 'delegation.revoke', revokedDelegation, SUCCESS);
    const afterRevoke = await harness.asAgent(
      'task.read',
      { recordId: revokable.id },
      revokedCredential,
    );
    observe('agent-after-pickup', 'k-revoke', 'task.read (after)', afterRevoke, notLive);

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

    // (g) I09, minimum contract 8.2 case 7, through R4 itself. The party is
    // `enrolExternal`'s: a person of alpha with a login and no membership, so
    // the active role keys stay `member` alone. The share is `shareRecord`'s,
    // the owning interface, issued by the admin under her own `share` grant.
    // `tests/acceptance/external-party.test.ts` is the full R4 suite; this is
    // the row the matrix owes for it.
    for (const written of await harness.writeBothComments(subject.id)) {
      expect(written.code).toBe('ok');
    }
    const external = await enrolExternal(harness.world);
    expect(await harness.activeRoleKeys()).toStrictEqual(['member']);
    const shared = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      shareRecord(
        tx,
        {
          personId: harness.world.ada.personId as string,
          actorId: harness.world.ada.actorId as string,
        },
        { collection: 'task', recordId: subject.id, personId: external.personId as string },
      ),
    );
    expect(shared.ok).toBe(true);
    const asExternal = { token: external.token };
    const externalRead = await harness.asPerson(
      'task.read',
      { recordId: subject.id },
      'alpha',
      asExternal,
    );
    observe('external-party', 'g-external-projection', 'task.read', externalRead, SUCCESS);
    const sharedTask = externalRead.body['sharedTask'] as Record<string, unknown>;
    expect(externalRead.body['task']).toBeUndefined();
    // Absent, not hidden: no field is classified `shared` as shipped, and the
    // one comment is the client's.
    expect(sharedTask['fields']).toStrictEqual({});
    expect(JSON.stringify(externalRead.body)).not.toContain('must never see');
    expect(JSON.stringify(externalRead.body)).not.toContain('the one task this delegation is for');
    expect(sharedTask['comments']).toHaveLength(1);
    // The rest of case 7: a sibling task and the board are `NOT_FOUND`.
    const externalSibling = await harness.asPerson(
      'task.read',
      { recordId: sibling.id },
      'alpha',
      asExternal,
    );
    const notFound = refusal('NOT_FOUND');
    const siblingRow = 'task.read (sibling)';
    observe('external-party', 'g-external-projection', siblingRow, externalSibling, notFound);
    const externalBoard = await harness.asPerson(
      'task.board',
      { board: null },
      'alpha',
      asExternal,
    );
    observe('external-party', 'g-external-projection', 'task.board', externalBoard, notFound);

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
      'k-handback',
      'k-revoke',
    ]) {
      expect(failures(kase), kase).toStrictEqual([]);
    }
  }, 300_000);
});
