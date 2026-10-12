// SPDX-License-Identifier: AGPL-3.0-only
//
// One sign-in subject that is a person's login in alpha and in bravo, with a
// manager in bravo who can end that person's access there (`access.end`), for
// the live-elsewhere proofs.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

export interface SharedSubject {
  readonly alpha: string;
  readonly bravo: string;
  readonly subject: string;
  readonly alphaLogin: string;
  readonly bravoPerson: string;
  readonly bravoMapping: string;
  readonly bravoManager: Member;
}

/** A person with a login of `subject` in `business`, live: their login and mapping ids. */
async function mappedPerson(db: FreshDatabase, business: string, subject: string) {
  return await db.app.withBusiness(business, async (tx) => {
    const person = await insertPerson(tx, 'Signs in to both');
    const actor = await insertActor(tx, person);
    await insertMembership(tx, person);
    const login = await insertLogin(tx, subject);
    return { person, login, mapping: await insertMapping(tx, login, person, actor) };
  });
}

export async function sharedSubject(db: FreshDatabase): Promise<SharedSubject> {
  const alpha = await insertBusiness(db.app, `alpha-${randomUUID()}`);
  const bravo = await insertBusiness(db.app, `bravo-${randomUUID()}`);
  await installSpine(db.app, bravo);
  const bravoManager = await enrol(db.app, bravo, 'Bea Manager');
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoManager, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  const subject = randomUUID();
  const inAlpha = await mappedPerson(db, alpha, subject);
  const inBravo = await mappedPerson(db, bravo, subject);
  return {
    alpha,
    bravo,
    subject,
    alphaLogin: inAlpha.login,
    bravoPerson: inBravo.person,
    bravoMapping: inBravo.mapping,
    bravoManager,
  };
}

/** Bravo's manager ends the shared person's access in bravo, and it commits. */
export async function endInBravo(db: FreshDatabase, pair: SharedSubject): Promise<void> {
  const answer = await executeCommand(db.app, pair.bravo, pair.bravoManager.presented, 'api', {
    command: 'access.end',
    operationId: randomUUID(),
    holderId: pair.bravoPerson,
  } as never);
  expect(isCommandRefusal(answer) ? answer.code : 'applied').toBe('applied');
}
