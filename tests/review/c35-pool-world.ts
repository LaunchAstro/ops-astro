// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2018): the capture pool's reviews in C35's world. ava manages operations in the
// business that operates the installation, dee manages them for party B only, and eve in beta;
// a review body is a closed other-company review of the pool the fence runs now.

import { randomUUID } from 'node:crypto';
import { CAPTURE_POOL_VERSION } from '../../packages/core-connectors/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import type { C35World } from './c35-world.ts';

export const RECORD = 'operations.record_capture_pool_review';

/** The grants and the installation's operator the pool's reviews are recorded under. */
export async function poolOperators(w: C35World): Promise<void> {
  const app = w.world.db.app;
  await app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.ava, 'manage', WHOLE_BUSINESS, false, 'operations');
    await grantTo(tx, w.dee, 'manage', { kind: 'party', id: w.partyB }, false, 'operations');
  });
  await app.withBusiness(w.beta, async (tx) => {
    await grantTo(tx, w.eve, 'manage', WHOLE_BUSINESS, false, 'operations');
  });
  await w.world.db.admin.execute('update ops.installation set operator_business_id = $1', [
    w.world.business,
  ]);
}

/** A closed review of the current pool, named `review`. */
export const poolReview = (
  review: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  command: RECORD,
  review,
  poolVersion: CAPTURE_POOL_VERSION,
  evidence: `https://reviews.example/pool/${review}`,
  company: 'Other Company Pty Ltd',
  ...overrides,
});

export const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'applied';

export const uniqueReview = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

/** Every pool review row, as one digest the administrator reads. */
export async function poolDigest(w: C35World): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ digest: string }>(
    `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
       from ops.capture_pool_reviews t`,
  );
  return row?.digest ?? '';
}

export type Crossing = readonly [label: string, send: () => Promise<CommandResult>, code: string];

/** Each crossing refused with its code, writing nothing and naming no planted review. */
export async function refusedCrossings(
  w: C35World,
  crossings: readonly Crossing[],
): Promise<string[]> {
  const wrong: string[] = [];
  for (const [label, attempt, expected] of crossings) {
    // oxlint-disable-next-line no-await-in-loop -- each crossing is measured alone
    const before = await poolDigest(w);
    // oxlint-disable-next-line no-await-in-loop
    const answered = await attempt();
    // oxlint-disable-next-line no-await-in-loop
    if ((await poolDigest(w)) !== before) wrong.push(`${label}: wrote`);
    if (codeOf(answered) !== expected) wrong.push(`${label}: ${codeOf(answered)}`);
    const said = JSON.stringify(answered);
    if (said.includes('reviews.example') || said.includes('Other Company')) {
      wrong.push(`${label}: named the planted review`);
    }
  }
  return wrong;
}

/** The application role's direct writes and evidence reads, each `denied` or what it did. */
export async function directAsApp(w: C35World): Promise<string[]> {
  const direct = [
    `update ops.capture_pool_reviews set status = 'closed'`,
    `update ops.capture_pool_reviews set pool_version = 'any'`,
    `delete from ops.capture_pool_reviews`,
    `select evidence from ops.capture_pool_reviews`,
    `select company from ops.capture_pool_reviews`,
  ];
  return await Promise.all(
    direct.map(
      async (sql) =>
        await w.world.db.app
          .withBusiness(w.world.business, async (tx) => await tx.query(sql))
          .then(
            () => `${sql}: allowed`,
            (error: unknown) =>
              /permission denied/u.test(String(error)) ? `${sql}: denied` : String(error),
          ),
    ),
  );
}

/** The recorded row and the audit events of `operationId`, as the administrator reads them. */
export async function recordedAndAudited(
  w: C35World,
  review: string,
  operationId: string,
): Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly audited: readonly Record<string, unknown>[];
  readonly whole: string;
}> {
  const rows = await w.world.db.admin.execute<Record<string, unknown>>(
    `select review, pool_version, status, evidence, company, operator_business_id::text as business,
            recorded_by_person_id::text as person, recorded_by_actor_id::text as actor,
            operation_id::text as operation
       from ops.capture_pool_reviews where review = $1`,
    [review],
  );
  const audited = await w.world.db.admin.execute<Record<string, unknown>>(
    `select business_id::text as business, actor_id::text as actor, command, outcome
       from audit_events where operation_id = $1`,
    [operationId],
  );
  const [whole] = await w.world.db.admin.execute<{ text: string }>(
    `select coalesce(string_agg(to_jsonb(a)::text, '|'), '') as text
       from audit_events a where operation_id = $1`,
    [operationId],
  );
  return { rows, audited, whole: whole?.text ?? '' };
}
