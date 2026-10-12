// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's hold (operator-runtime.ts, `holdingGrant`), under which a store part
// read and every deployment record start: each change is tried on its own connection.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { endOtherSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  RECORD_FILE,
  recordDeployment,
  requireOperatingOperator,
  type Gate,
} from '../../scripts/ops/operator.ts';
import { signBearer } from '../support/sign-in.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { environment, ISSUER, operatorOnlyHooks, serverUrl } from './operator-only.fixture.ts';
import { manager, marks, scratch } from './operator-only-commands.fixture.ts';

let db: FreshDatabase;
let business = '';
type Held = Extract<Gate, { ok: true }>;

/** A person of the operating business with a login, an actor and a mapping. */
interface Operator {
  readonly subject: string;
  readonly personId: string;
  readonly actorId: string;
  readonly loginId: string;
  readonly mappingId: string;
}

async function operator(tx: TenantQuery): Promise<Operator> {
  const subject = `hold-${randomUUID()}`;
  const personId = await insertPerson(tx, 'Hollis');
  const actorId = await insertActor(tx, personId);
  await insertMembership(tx, personId);
  const loginId = await insertLogin(tx, subject);
  const mappingId = await insertMapping(tx, loginId, personId, actorId);
  return { subject, personId, actorId, loginId, mappingId };
}

/** `operations:manage` over the whole business, to `to`; its id. */
async function grant(
  tx: TenantQuery,
  by: Operator,
  to: { kind: 'person' | 'actor'; id: string },
  more: { parentGrantId?: string; canDelegate?: boolean; expiresAt?: Date } = {},
): Promise<string> {
  const issued = await issueGrant(tx, [{ kind: 'actor', id: by.actorId }], {
    subject: to,
    scope: { kind: 'business', id: null },
    collection: 'operations',
    action: 'manage',
    parentGrantId: more.parentGrantId ?? null,
    grantedByActorId: by.actorId,
    ...(more.canDelegate === undefined ? {} : { canDelegate: more.canDelegate }),
    ...(more.expiresAt === undefined ? {} : { expiresAt: more.expiresAt }),
  });
  if (!issued.ok) throw new Error('fixture grant refused');
  return issued.value;
}

const inBusiness = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await db.app.withBusiness(business, run);

/** A person holding the key over the whole business, as `to` names: their own person row by default. */
async function admittedOperator(
  as: 'person' | 'actor' = 'person',
): Promise<Operator & { grantId: string }> {
  return await inBusiness(async (tx) => {
    const made = await operator(tx);
    const to = as === 'person' ? made.personId : made.actorId;
    return { ...made, grantId: await grant(tx, made, { kind: as, id: to }) };
  });
}

/** The gate for `subject`'s sign-in, with a session and the claims `extra` sets. */
async function gateFor(subject: string, extra: Record<string, unknown> = {}): Promise<Held> {
  const env = environment(marks(manager(false)), process.env['PATH'] ?? '', {
    OPS_ASTRO_TOKEN: await signBearer({
      sub: subject,
      iss: ISSUER,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 600,
      ...extra,
    }),
  });
  const gate = await requireOperatingOperator(env);
  if (!gate.ok) throw new Error(`fixture operator was not admitted: ${gate.reason}`);
  return gate;
}

/** `change` tried while `gate` holds, on another connection: did it wait for the hold? */
async function triedDuringHold(
  gate: Held,
  change: (tx: TenantQuery) => Promise<unknown>,
): Promise<'waited' | 'went through'> {
  return await gate.holdingGrant(async (release) => {
    const outcome = await inBusiness(async (tx) => {
      await tx.query("set local lock_timeout = '500ms'");
      await change(tx);
    }).then(
      () => 'went through' as const,
      (error: unknown) => {
        if ((error as { code?: unknown }).code !== '55P03') throw error;
        return 'waited' as const;
      },
    );
    release();
    return outcome;
  });
}

const ENDED = /no longer holds operations:manage/u;
const ACT = { act: 'made-up deploy' };
const recorded = (gate: Held): boolean => existsSync(join(gate.records, RECORD_FILE));
/** The sign-in attempts recorded against `loginId` (I13). */
async function attempts(loginId: string): Promise<number> {
  const [row] = await db.admin.execute<{ n: number }>(
    'select count(*)::int as n from public.authentication_attempts where login_id = $1',
    [loginId],
  );
  return row?.n ?? 0;
}

const ended = (table: 'actors' | 'person_logins', id: string) => async (tx: TenantQuery) =>
  await tx.query(
    `update public.${table} set active = false, deactivated_at = now() where id = $1`,
    [id],
  );

async function actorGrantRevocationWaits(): Promise<void> {
  const held = await admittedOperator('actor');
  const gate = await gateFor(held.subject);
  const revoke = async (tx: TenantQuery): Promise<unknown> => await revokeGrant(tx, held.grantId);
  expect(await triedDuringHold(gate, revoke)).toBe('waited');
  expect(await inBusiness(revoke)).toBeInstanceOf(Date);
}

async function parentRevocationWaits(): Promise<void> {
  const { subject, parentId } = await inBusiness(async (tx) => {
    const delegator = await operator(tx);
    const own = { kind: 'actor' as const, id: delegator.actorId };
    const parent = await grant(tx, delegator, own, { canDelegate: true });
    const delegate = await operator(tx);
    const to = { kind: 'person' as const, id: delegate.personId };
    await grant(tx, delegator, to, { parentGrantId: parent });
    return { subject: delegate.subject, parentId: parent };
  });
  const gate = await gateFor(subject);
  const revoke = async (tx: TenantQuery): Promise<unknown> => await revokeGrant(tx, parentId);
  expect(await triedDuringHold(gate, revoke)).toBe('waited');
}

async function actorOrMappingEndWaits(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  expect(await triedDuringHold(gate, ended('actors', held.actorId))).toBe('waited');
  expect(await triedDuringHold(gate, ended('person_logins', held.mappingId))).toBe('waited');
}

async function loginWideEndingWaits(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  const endAll = async (tx: TenantQuery): Promise<unknown> =>
    await endOtherSeenSessions(tx, held.personId, undefined, 'end_others', held.subject);
  expect(await triedDuringHold(gate, endAll)).toBe('waited');
}

async function grantEndingInsideBudgetRefused(): Promise<void> {
  const held = await inBusiness(async (tx) => {
    const made = await operator(tx);
    const expiresAt = new Date(Date.now() + 10_000);
    await grant(tx, made, { kind: 'person', id: made.personId }, { expiresAt });
    return made;
  });
  const gate = await gateFor(held.subject);
  await expect(gate.holdingGrant(() => Promise.resolve('held'))).rejects.toThrow(ENDED);
}

async function sessionLimitInsideBudgetRefused(): Promise<void> {
  const held = await admittedOperator();
  const signedInAt = Math.floor(Date.now() / 1000) - 12 * 60 * 60 + 10;
  const amr = [{ method: 'password', timestamp: signedInAt }];
  const gate = await gateFor(held.subject, { amr });
  await expect(gate.holdingGrant(() => Promise.resolve('held'))).rejects.toThrow(ENDED);
}

async function holdPastBudgetRefused(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  const late = gate.holdingGrant(async (release) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
    release();
    return 'released';
  }, 1_000);
  await expect(late).rejects.toThrow(ENDED);
}

async function endedSessionRecordsNothing(): Promise<void> {
  const held = await admittedOperator();
  const sessionId = randomUUID();
  const gate = await gateFor(held.subject, { session_id: sessionId });
  await db.admin.execute('insert into ops.ended_provider_sessions (session_id) values ($1)', [
    sessionId,
  ]);
  await expect(recordDeployment(gate, ACT)).rejects.toThrow(ENDED);
  expect(recorded(gate)).toBe(false);
}

async function revokedGrantRecordsNothing(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  await inBusiness(async (tx) => await revokeGrant(tx, held.grantId));
  await expect(recordDeployment(gate, ACT)).rejects.toThrow(ENDED);
  expect(recorded(gate)).toBe(false);
}

async function remappedLoginRecordsNothing(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  await inBusiness(async (tx) => {
    const other = await insertPerson(tx, 'Rowan');
    const otherActor = await insertActor(tx, other);
    await insertMembership(tx, other);
    await grant(tx, held, { kind: 'person', id: other });
    await ended('person_logins', held.mappingId)(tx);
    await insertMapping(tx, held.loginId, other, otherActor);
  });
  const before = await attempts(held.loginId);
  await expect(recordDeployment(gate, ACT)).rejects.toThrow(ENDED);
  expect({ recorded: recorded(gate), attempts: await attempts(held.loginId) }).toEqual({
    recorded: false,
    attempts: before,
  });
}

async function standingOperatorRecorded(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  const before = await attempts(held.loginId);
  const record = await recordDeployment(gate, ACT);
  expect(record).toMatchObject({ ...ACT, operator: held.personId });
  expect({ recorded: recorded(gate), attempts: await attempts(held.loginId) }).toEqual({
    recorded: true,
    attempts: before + 1,
  });
}

describe.skipIf(serverUrl === undefined)("the operator gate's hold", () => {
  operatorOnlyHooks((state) => {
    db = state.db;
    business = state.alphaBusiness;
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'revoking an actor-addressed grant waits for the hold, then goes through',
    actorGrantRevocationWaits,
  );
  it("revoking a delegated grant's parent waits for the hold", parentRevocationWaits);
  it('ending the actor or the login mapping waits for the hold', actorOrMappingEndWaits);
  it("ending every session of the operator's login waits for the hold", loginWideEndingWaits);
  it('a grant that expires inside the budget gets no hold', grantEndingInsideBudgetRefused);
  it(
    'a session reaching its twelve-hour limit inside the budget gets no hold',
    sessionLimitInsideBudgetRefused,
  );
  it(
    'a hold not released within its budget ends there and refuses the release',
    holdPastBudgetRefused,
  );
  it('a session ended after the act writes no deployment record', endedSessionRecordsNothing);
  it('a grant revoked after the act writes no deployment record', revokedGrantRecordsNothing);
  it(
    'a login remapped to another person after the act records nothing',
    remappedLoginRecordsNothing,
  );
  it(
    'a deployment by an operator still standing is recorded once, with its sign-in',
    standingOperatorRecorded,
  );
});
