// SPDX-License-Identifier: AGPL-3.0-only
//
// R5's world (#1689): the C80 world, in which business beta has one operator
// (eve), its configured approver, granted settings:manage there; alpha's
// administrator holds settings:manage too. With the helpers both
// single-operator suites use.

import { expect } from 'vitest';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';
import { lockWaiters } from './party-site-races.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

const WHOLE = { kind: 'business', id: null } as const;
export const REVIEW = 'Astra: the one word changes at the approved place; nothing else moves.';

type Body = Readonly<Record<string, unknown>>;
export interface Asked {
  readonly id: string;
  readonly versionId: string;
  readonly digest: string;
}

export async function soloWorld(part: string): Promise<C80World> {
  const w = await c80World(part);
  await w.world.db.app.withBusiness(w.beta, async (tx) => {
    await grantTo(tx, w.eve, 'manage', WHOLE, false, 'settings');
  });
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.admin, 'manage', WHOLE, false, 'settings');
  });
  return w;
}

export const asEve = async (w: C80World, body: Body): Promise<CommandResult> =>
  await w.asIn(w.beta, w.eve, body);

/** Eve's request on beta's task: a fresh correction, its id, version and digest. */
export async function eveRequests(w: C80World): Promise<Asked> {
  const asked = await asEve(w, requestBody(w.betaParty, w.betaTask));
  expect(codeOf(asked)).toBe('not-a-refusal');
  const detail = detailOf(asked);
  return {
    id: String(detail['correctionId']),
    versionId: String(detail['versionId']),
    digest: String(detail['versionDigest']),
  };
}

export const decide = async (
  w: C80World,
  correction: { id: string; versionId: string },
): Promise<CommandResult> =>
  await asEve(w, {
    command: 'live_correction.decide',
    correctionId: correction.id,
    versionId: correction.versionId,
    decision: 'approve',
  });

export const recordReview = async (
  w: C80World,
  correctionId: string,
  versionDigest: string,
  verdict = 'approve',
): Promise<CommandResult> =>
  await asEve(w, {
    command: 'live_correction.record_review',
    correctionId,
    versionDigest,
    verdict,
    review: REVIEW,
  });

export const setMode = async (
  w: C80World,
  business: string,
  member: C80World['eve'],
  value: boolean,
): Promise<CommandResult> =>
  await w.asIn(business, member, { command: 'settings.set_single_operator', value });

export async function rowOf(w: C80World, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await w.world.db.admin.execute<Record<string, unknown>>(
    `select state, decided_by_person_id, single_operator_self_approval
       from public.live_corrections where id = $1`,
    [id],
  );
  return row;
}

export async function modeIn(w: C80World, business: string): Promise<unknown> {
  const [row] = await w.world.db.admin.execute<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = 'single_operator_mode'`,
    [business],
  );
  return row?.value;
}

export interface HeldTransaction {
  readonly ready: Promise<void>;
  release(): void;
  readonly done: Promise<unknown>;
}

/** `work` in a transaction of beta's on its own connection, held open until released. */
export function heldInBeta(
  w: C80World,
  work: (tx: TransactionQuery) => Promise<unknown>,
): HeldTransaction {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  let ready!: () => void;
  let release!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = own
    .withBusiness(w.beta, async (tx) => {
      const answer = await work(tx);
      ready();
      await released;
      return answer;
    })
    .finally(async () => {
      await own.close();
    });
  return { ready: isReady, release, done };
}

/** A decision waiting on a settings row's share lock: the approver's or the mode's. */
export const SETTING_WAIT: RegExp = /from public\.business_settings[\s\S]*for share/u;

export async function waitFor(w: C80World, statement: RegExp): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    if ((await lockWaiters(w)).some((query) => statement.test(query))) return;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`nothing waited on ${String(statement)}`);
}
