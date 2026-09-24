// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-DBTEST #64: the two storage triggers the runtime relies on, each branch
// broken on purpose, as the application role and as the owner.
//
// 0010's proposal_versions_immutable keeps what a version says fixed and sets
// superseded_at once (G04: a decision signed over a payload keeps meaning what
// it meant). 0014's attempts_immutable keeps an attempt's provenance fixed,
// settles actual_minor and outcome once, and never lets a marker be lowered
// (RUNTIME.md: "0014's trigger refuses to let either flag be lowered"). The
// command paths never try any of this, so without these cases a later
// migration could weaken either trigger and every suite would stay green.
//
// The owner is a superuser and passes row security, so its refusals are the
// trigger's alone. The application role holds no DELETE on either table, so
// its deletes stop at the privilege (42501) before the trigger is reached.
// Each case asserts the branch's own message, so dropping one branch of a
// trigger turns its case red rather than leaving another branch to answer.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import {
  buildFixture,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from '../runtime/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r1-dbtest-triggers: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const RESTRICT = '23001';
const DENIED = '42501';

type Role = 'application' | 'owner';

// Every statement takes the same three parameters (business, version, attempt),
// so each names all three whichever row it writes.
const version = (set: string): string =>
  `update public.proposal_versions set ${set} where business_id = $1 and id = $2 and $3::uuid is not null`;
const attempt = (set: string): string =>
  `update public.attempts set ${set} where business_id = $1 and id = $3 and $2::uuid is not null`;

describe.skipIf(serverUrl === undefined)('the 0010 and 0014 storage triggers', () => {
  let database: FreshDatabase;
  let fixture: RuntimeFixture;
  let versionId: string;
  let attemptId: string;

  /** Run the statements in one transaction as `role`; it always rolls back. */
  async function asRole(role: Role, statements: readonly string[]): Promise<void> {
    const parameters = [fixture.businessId, versionId, attemptId];
    const run = async (execute: (sql: string) => Promise<unknown>): Promise<never> => {
      for (const sql of statements) {
        // In order, in one transaction: the second write is the one refused.
        // oxlint-disable-next-line no-await-in-loop
        await execute(sql);
      }
      throw new Error('ROLLBACK: every statement was accepted');
    };
    if (role === 'owner') {
      await database.admin.transaction(
        async (execute) => await run(async (sql) => await execute(sql, parameters)),
      );
    } else {
      await database.app.withBusiness(
        fixture.businessId,
        async (tx) => await run(async (sql) => await tx.query(sql, parameters)),
      );
    }
  }

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'fr1dbtesttriggers' });
    fixture = await buildFixture(database.app, 'triggerbiz');
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const proposed = await propose(tx, {
        taskId: fixture.taskId,
        collection: TASK_COLLECTION,
        proposedByActorId: fixture.decider.actorId,
        subjects: subjectsOf(fixture.decider),
        purpose: 'draft_the_brief',
        maximumMinor: 5_000,
        currency: 'AUD',
        payload: { instruction: 'draft it' },
        step: { kind: 'local.draft', payload: { words: 200 } },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
      const decided = await decide(tx, {
        gateId: proposed.value.gateId,
        versionId: proposed.value.versionId,
        decidedByPersonId: fixture.decider.personId,
        decidedByActorId: fixture.decider.actorId,
        subjects: subjectsOf(fixture.decider),
        collection: TASK_COLLECTION,
        decision: 'approve',
        note: 'go',
        signingKey: TEST_SIGNING_KEY,
        capId: fixture.capId,
      });
      if (!decided.ok || decided.value.decision !== 'approve') {
        throw new Error('expected an approval');
      }
      versionId = proposed.value.versionId;
      attemptId = decided.value.attemptId;
    });
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  /** The rows as the owner reads them, so each case can show nothing moved. */
  async function rows(): Promise<unknown> {
    return await database.admin.execute(
      `select (select row_to_json(v) from public.proposal_versions v where v.id = $1) as version,
              (select row_to_json(a) from public.attempts a where a.id = $2) as attempt`,
      [versionId, attemptId],
    );
  }

  const refusals: readonly {
    readonly name: string;
    readonly statements: (role: Role) => readonly string[];
    readonly message: RegExp;
  }[] = [
    {
      name: 'rewriting a version payload',
      statements: () => [version(`payload = '{"instruction":"something else"}'::jsonb`)],
      message: /proposal_versions are immutable: version .* cannot be edited/u,
    },
    {
      name: 'rewriting a version payload digest',
      statements: () => [version(`payload_digest = repeat('0', 64)`)],
      message: /proposal_versions are immutable: version .* cannot be edited/u,
    },
    {
      name: 'setting superseded_at a second time',
      statements: () => [
        version('superseded_at = now()'),
        version(`superseded_at = superseded_at + interval '1 second'`),
      ],
      message: /version .* is already superseded/u,
    },
    {
      name: "changing an attempt's estimate",
      statements: () => [attempt('estimated_minor = estimated_minor + 1')],
      message: /attempts are immutable: attempt .* has provenance that cannot be edited/u,
    },
    {
      name: "changing an attempt's version",
      statements: () => [attempt('version_id = gen_random_uuid()')],
      message: /attempts are immutable: attempt .* has provenance that cannot be edited/u,
    },
    {
      name: 'settling actual_minor a second time',
      statements: () => [attempt('actual_minor = 0'), attempt('actual_minor = 1')],
      message: /attempt .* is already settled at 0/u,
    },
    {
      name: 'recording an outcome a second time',
      statements: () => [attempt(`outcome = 'completed'`), attempt(`outcome = 'failed'`)],
      message: /attempt .* already recorded outcome completed/u,
    },
    {
      name: 'lowering a dispatch marker',
      statements: () => [
        attempt(`dispatch_marker = true, state = 'quarantined'`),
        attempt('dispatch_marker = false'),
      ],
      message: /attempt .* carries a dispatch marker, which cannot be cleared/u,
    },
    {
      name: 'lowering an observation',
      statements: () => [
        attempt(`observed = true, state = 'quarantined'`),
        attempt('observed = false'),
      ],
      message: /attempt .* carries an observation, which cannot be cleared/u,
    },
  ];

  for (const role of ['application', 'owner'] as const) {
    describe(`as the ${role === 'owner' ? 'owner' : 'application role'}`, () => {
      for (const refusal of refusals) {
        it(`refuses ${refusal.name} with restrict_violation`, async () => {
          const before = await rows();
          await expect(asRole(role, refusal.statements(role))).rejects.toMatchObject({
            code: RESTRICT,
            message: expect.stringMatching(refusal.message),
          });
          expect(await rows()).toStrictEqual(before);
        });
      }

      it('refuses deleting a version', async () => {
        const before = await rows();
        await expect(
          asRole(role, [
            'delete from public.proposal_versions where business_id = $1 and id = $2 and $3::uuid is not null',
          ]),
        ).rejects.toMatchObject(
          role === 'owner'
            ? {
                code: RESTRICT,
                message: expect.stringMatching(/version .* cannot be deleted/u),
              }
            : { code: DENIED, message: expect.stringMatching(/permission denied/u) },
        );
        expect(await rows()).toStrictEqual(before);
      });

      it('refuses deleting an attempt', async () => {
        const before = await rows();
        await expect(
          asRole(role, [
            'delete from public.attempts where business_id = $1 and id = $3 and $2::uuid is not null',
          ]),
        ).rejects.toMatchObject(
          role === 'owner'
            ? {
                code: RESTRICT,
                message: expect.stringMatching(/attempt .* cannot be deleted/u),
              }
            : { code: DENIED, message: expect.stringMatching(/permission denied/u) },
        );
        expect(await rows()).toStrictEqual(before);
      });

      // The positive controls: the writes each trigger permits go through, so
      // the refusals above are the rule's, not a blanket block on the table.
      it('accepts superseding once, settling once and raising a marker', async () => {
        await expect(
          asRole(role, [
            version('superseded_at = now()'),
            attempt('actual_minor = 0'),
            attempt(`outcome = 'completed'`),
            attempt(`dispatch_marker = true, observed = true, state = 'quarantined'`),
          ]),
        ).rejects.toThrow('ROLLBACK: every statement was accepted');
      });
    });
  }
});
