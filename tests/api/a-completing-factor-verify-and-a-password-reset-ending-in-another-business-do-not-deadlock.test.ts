// SPDX-License-Identifier: AGPL-3.0-only
//
// A completing factor verify against C40's reset ending in another business
// (security re-bind SEC-B1A-R6, R6-1). The verify ends the person's other
// sessions here, holding the subject's ending key and theirs exclusively, then
// asks its own session shared (`judged`). The reset's ending in another
// business takes that business's chain, then every session seen there sorted.
// Were the act's own session to sort first and the reset to skip the subject's
// key, each would hold a session key the other waits for. The reset's ending
// takes the subject's key first, in `holdEnding`'s one order (ending-keys.ts),
// so it waits for the act, which is then refused, its window open.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import { setPasswordByToken } from '../../packages/core-commands/src/index.ts';
import { sessionKey } from '../../packages/core-records/src/identity/ending-keys.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  liveFactor,
  recordFactorEnrolled,
} from '../../packages/core-records/src/identity/second-factor.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/index.ts';
import {
  connect,
  type BusinessId,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import { backendPid, blockedBy } from '../identity/factor-ending-keys-fixture.ts';
import { provider } from '../identity/factor-lock-wait-fixture.ts';
import { gate } from '../support/lock-waits.ts';
import {
  broker,
  freshMember,
  inBravoToo,
  mintToken,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();
const SOL = it.skipIf(serverUrl === undefined);

/** One stop: before the first statement `at` matches, or straight after it. */
interface Stop {
  readonly at: (text: string, parameters: readonly unknown[]) => boolean;
  readonly after?: boolean;
}

interface Stopped {
  readonly database: Database;
  /** Each stop's backend, once that stop is reached. */
  readonly reached: readonly Promise<number>[];
  readonly release: (stop: number) => void;
  readonly releaseAll: () => void;
}

/**
 * A pool whose transactions stop at each of `plan`'s statements in turn, each
 * waiting for its release. Every statement is the real one; only waits are added.
 */
function stopsAt(inner: Database, plan: readonly Stop[]): Stopped {
  const marks = plan.map(() => {
    let mark!: (pid: number) => void;
    const reached = new Promise<number>((resolve) => {
      mark = resolve;
    });
    return { reached, mark, going: gate() };
  });
  let next = 0;
  const due = (text: string, parameters: readonly unknown[] | undefined, after: boolean) => {
    const stop = plan[next];
    return stop !== undefined && (stop.after ?? false) === after && stop.at(text, parameters ?? []);
  };
  const pause = async (tx: TransactionQuery) => {
    const mark = marks[next];
    next += 1;
    mark?.mark(await backendPid(tx));
    await mark?.going.promise;
  };
  const stopping = (tx: TransactionQuery): TransactionQuery => ({
    businessId: tx.businessId,
    savepoint: tx.savepoint,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      if (due(text, parameters, false)) await pause(tx);
      const rows = await tx.query<Row>(text, parameters);
      if (due(text, parameters, true)) await pause(tx);
      return rows;
    },
  });
  return {
    database: {
      log: inner.log,
      close: async () => await inner.close(),
      withBusiness: async (businessId, run) =>
        await inner.withBusiness(businessId, async (tx) => await run(stopping(tx))),
    },
    reached: marks.map((mark) => mark.reached),
    release: (stop) => marks[stop]?.going.release(),
    releaseAll: () => {
      for (const mark of marks) mark.going.release();
    },
  };
}

/** What a call answered, or the error it failed with (a deadlock is one). */
const answer = (settled: PromiseSettledResult<unknown>): unknown =>
  settled.status === 'fulfilled' ? settled.value : { failed: String(settled.reason) };

/** A stop reached, or the call that should have reached it finished first. */
async function reach(stop: Promise<number> | undefined, call: Promise<unknown>, what: string) {
  const finished = call.then(
    (value) => ({ value }),
    (error: unknown) => ({ value: { failed: String(error) } }),
  );
  const first = await Promise.race([stop ?? finished, finished]);
  if (typeof first === 'number') return first;
  throw new Error(`${what} finished before its stop: ${JSON.stringify(first.value)}`);
}

/**
 * A member of alpha with the same login in bravo, an enrolment not yet
 * completed, and two sessions, S sorting before A: both seen in bravo, A in
 * alpha too. The act is S's first good code; the reset is by a token of alpha's.
 */
async function scene() {
  const member = await freshMember('r6-completing-verify');
  const { subject } = member.presented;
  await inBravoToo(subject, 'r6-completing-verify-bravo');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await recordFactorEnrolled(tx, {
      personId: member.personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
  });
  const [s = '', a = ''] = [randomUUID(), randomUUID()].toSorted((x, y) =>
    sessionKey(x) < sessionKey(y) ? -1 : 1,
  );
  const signedInAt = Math.floor(Date.now() / 1000) - 2;
  const on = (sessionId: string): VerifiedSubject => ({
    provider: 'supabase',
    subject,
    sessionId,
    assurance: { level: 'aal1', signedInAt, factorAt: null },
  });
  const seen: [BusinessId, string][] = [
    [world.bravo, s],
    [world.bravo, a],
    [world.alpha, a],
  ];
  for (const [business, sessionId] of seen) {
    // oxlint-disable-next-line no-await-in-loop -- one committed resolve at a time
    const resolved = await world.db.app.withBusiness(business, (tx) =>
      resolveLogin(tx, on(sessionId), 'enrolling'),
    );
    if ('refused' in resolved) throw new Error(`session not seen: ${resolved.code}`);
  }
  const caller: FactorCaller = {
    database: world.db.app,
    businessId: world.alpha,
    accessToken: 'local-test-bearer',
    presented: on(s),
  };
  return { caller, person: member.personId, token: await mintToken(subject) };
}

/** The act's two stops: before it takes the factor key, and after its audit row. */
const ACT_STOPS: readonly Stop[] = [
  { at: (_text, parameters) => String(parameters[0]).startsWith('second-factor-subject:') },
  { at: (text) => text.includes('insert into audit_events'), after: true },
];

/** The reset's one stop: bravo's ending, before its first ending key (bravo's chain). */
const resetStop = (): readonly Stop[] => [
  {
    at: (text, parameters) =>
      text.includes('pg_advisory_xact_lock') && parameters[0] === world.bravo.toLowerCase(),
  },
];

SOL(
  'a completing factor verify and a password reset ending in another business do not deadlock',
  async () => {
    const { caller, person, token } = await scene();
    const act = stopsAt(connect(world.db.appUrl), ACT_STOPS);
    const reset = stopsAt(connect(world.db.appUrl), resetStop());
    try {
      const to = provider([]);
      const acting = verifySecondFactor(
        { ...caller, database: act.database },
        { code: '123456' },
        to,
      );
      // Its door has resolved S live: no window is open yet.
      const actor = await reach(act.reached[0], acting, 'the verify');
      let resetDone = false;
      const resetting = setPasswordByToken(
        reset.database,
        [world.alpha, world.bravo],
        { broker },
        { token, password: 'r6 completing verify new password' },
      ).finally(() => {
        resetDone = true;
      });
      // The window is spent open and the password set; bravo's ending is next.
      await reach(reset.reached[0], resetting, 'the reset');
      act.release(0);
      // The act has ended A here, the subject's key and A's held, its audit row written.
      await reach(act.reached[1], acting, 'the verify');
      reset.release(0);
      await blockedBy(world.db.admin, actor, () => resetDone, "the reset's ending in bravo");
      act.release(1);
      const [actResult, resetResult] = (await Promise.allSettled([acting, resetting])).map(
        (settled) => answer(settled),
      );
      const live = await world.db.app.withBusiness(world.alpha, (tx) => liveFactor(tx, person));
      expect({ actResult, resetResult, status: live?.status }).toMatchObject({
        actResult: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
        resetResult: { ok: true },
        status: 'unverified',
      });
    } finally {
      act.releaseAll();
      reset.releaseAll();
      await Promise.all([act.database.close(), reset.database.close()]);
    }
  },
);
