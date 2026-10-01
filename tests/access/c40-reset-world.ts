// SPDX-License-Identifier: AGPL-3.0-only
//
// What the C40 reset cases share over C39-T's hook world: a login mapped in
// businesses, the recovery message the login provider's Send Email hook sends
// for it, the mails an address got, and for the ask's limits a login provider
// whose recover is a custody stand-in that counts each dispatch.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { enrolmentBroker } from '../../apps/api/enrolment-broker.ts';
import { RESET_LIMIT } from '../../packages/core-commands/src/index.ts';
import type { Broker, Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { mountAuthHook, postAuth, tokenHash } from './c39-t-hook-world.ts';
import { w } from './c39-t-world.ts';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface Login {
  readonly subject: string;
  readonly address: string;
  /** The login's actor in each business it is mapped in. */
  readonly actors: Readonly<Record<string, string>>;
}

/** A login under a provider user id, mapped to a person in each of `businesses`. */
export async function loginIn(businesses: readonly string[], address?: string): Promise<Login> {
  const subject = randomUUID();
  const actors: Record<string, string> = {};
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time
    actors[business] = await w.db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, `reset-${subject.slice(0, 8)}`);
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      return actorId;
    });
  }
  return { subject, address: address ?? `reset-${subject.slice(0, 8)}@example.test`, actors };
}

/** A recovery message as the login provider sends it, its one-time code a canary. */
export const recoveryFor = (login: Login, hash: string = tokenHash(), otp = '305805'): string =>
  JSON.stringify({
    user: { id: login.subject, aud: 'authenticated', email: login.address, user_metadata: {} },
    email_data: {
      token: otp,
      token_hash: hash,
      redirect_to: 'https://ops.example.test',
      email_action_type: 'recovery',
      site_url: 'https://ops.example.test',
      token_new: '',
      token_hash_new: '',
    },
  });

export const mailsTo = (address: string): readonly string[] =>
  w.provider.received.map((one) => one.body).filter((body) => body.includes(`"${address}"`));

/** The provider's recover, counted: a custody stand-in answering every dispatch 200. */
export function recoverCounted(): { broker: Broker; recovered: string[] } {
  const recovered: string[] = [];
  const custody = {
    dispatch: async (_ref: string, request: { readonly path: string; readonly body: string }) => {
      recovered.push(`${request.path} ${request.body}`);
      return await Promise.resolve<CustodyOutcome>({
        kind: 'answered',
        started: true,
        outbound: { ok: true, status: 200, body: '{}' },
        credentialKind: 'api_key',
        account: null,
      });
    },
  } as unknown as Custody;
  return { broker: enrolmentBroker(custody), recovered };
}

/** A client address no other case or run uses. */
export const freshSource = (): string => `198.51.100.${randomBytes(6).toString('hex')}`;

/** A login of alpha whose address has had its `RESET_LIMIT` reset mails in the hour. */
export async function mailedOut(): Promise<Login> {
  mountAuthHook();
  w.provider.mode('accept');
  const login = await loginIn([w.alpha]);
  for (let sent = 0; sent < RESET_LIMIT; sent += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one message at a time
    await postAuth(recoveryFor(login));
  }
  expect(mailsTo(login.address)).toHaveLength(RESET_LIMIT);
  return login;
}
