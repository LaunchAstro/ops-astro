// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's session races (PRV-oa-984-R2.1): a sign-in of its own for one call,
// a provider that confirms every sign-out, and the application's pool with one
// stop straight after a change's last read of its session's endings, so a
// sign-out can be sent at exactly that point rather than by luck.

import { randomUUID } from 'node:crypto';
import type { FactorProvider } from '../../packages/core-commands/src/index.ts';
import {
  connectAsAdmin,
  type Database,
  type TransactionQuery,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { ISSUER } from '../api/fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { WAITING } from './race-hold.ts';
import type { RegistryWorld } from './registry-world.ts';

/** A provider that confirms every sign-out and is asked for nothing else. */
const done = Promise.resolve({ ok: true, value: undefined } as const);
export const provider: FactorProvider = {
  verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
  enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
  verify: () => Promise.resolve({ ok: false, fault: 'refused' }),
  remove: () => done,
  signOut: () => done,
};

/** A new sign-in of automationOnly's: its own provider session, and the token it verifies to. */
export async function signedInOf(
  w: RegistryWorld,
): Promise<{ readonly presented: VerifiedSubject; readonly bearer: string }> {
  const sessionId = randomUUID();
  const presented = { ...w.automationOnly.presented, sessionId };
  const bearer = await signBearer({
    sub: presented.subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 600,
    session_id: sessionId,
  });
  return { presented, bearer };
}

/** The stop: `wrap` gives a pool its stop, `arm` sets it once and answers when it is reached. */
interface Stop {
  wrap(inner: Database): Database;
  arm(): { readonly stopped: Promise<void>; readonly release: () => void };
}

interface Armed {
  readonly reached: () => void;
  readonly released: Promise<void>;
}

/** One transaction's statements, stopped once at the last session read after `chainKey` is taken. */
function stoppedTransaction(
  tx: TransactionQuery,
  chainKey: string,
  take: () => Armed | undefined,
): TransactionQuery {
  let chained = false;
  return {
    businessId: tx.businessId,
    savepoint: tx.savepoint,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const rows = await tx.query<Row>(text, parameters);
      if (text.includes('pg_advisory_xact_lock(') && parameters?.[0] === chainKey) chained = true;
      const live = (rows[0] as { readonly ended?: unknown } | undefined)?.ended === false;
      if (chained && live && text.includes('ended_provider_sessions')) {
        const stop = take();
        if (stop !== undefined) {
          stop.reached();
          await stop.released;
        }
      }
      return rows;
    },
  };
}

/**
 * The application's pool with one stop, once armed: a change's last read of
 * its session's endings, after `business`'s audit chain is taken, answers
 * live, and the change waits there for `release()`. Every statement is the
 * real one; only the wait is added.
 */
export function stopAfterLastSessionRead(business: string): Stop {
  let armed: Armed | undefined;
  const take = () => {
    const stop = armed;
    armed = undefined;
    return stop;
  };
  const wrap = (inner: Database): Database => ({
    log: inner.log,
    close: async () => await inner.close(),
    withBusiness: async (businessId, run) =>
      await inner.withBusiness(
        businessId,
        async (tx) => await run(stoppedTransaction(tx, business.toLowerCase(), take)),
      ),
  });
  const arm = () => {
    let reached!: () => void;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    armed = { reached, released };
    return { stopped, release };
  };
  return { wrap, arm };
}

/** Polls until the sign-out has finished or waits on a lock; answers whether it waits. */
export async function signOutWaits(holderUrl: string, finished: () => boolean): Promise<boolean> {
  const holder = connectAsAdmin(holderUrl, { source: 'harness' });
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (finished()) return false;
      // eslint-disable-next-line no-await-in-loop -- polling until it waits or finishes
      const [row] = await holder.execute<{ readonly n: string }>(WAITING, []);
      if (Number(row?.n) >= 1) return true;
      if (Date.now() > deadline) throw new Error('the sign-out neither finished nor waited');
      // eslint-disable-next-line no-await-in-loop -- as above
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  } finally {
    await holder.close();
  }
}
