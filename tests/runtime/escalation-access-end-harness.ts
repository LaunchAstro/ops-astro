// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation raced against `access.end` of its recipient, each on a backend
// of its own. The escalation is `decide` called raw, paused at a named
// statement by wrapping its TenantQuery; `access.end` goes through the command
// entry, which retries a 40P01 once (`register-store.ts`), so its outcome
// alone hides a deadlock. The server's deadlock counter for this database is
// read before the race and again once both backends have exited, which is when
// a backend's pending counts are flushed.

import { randomUUID } from 'node:crypto';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  asPerson,
  barrier,
  codeOf,
  racer,
  rows,
  scalar,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

/** Where the escalation stops: before or after the first statement `at` matches. */
export interface PauseAt {
  readonly at: (sql: string) => boolean;
  readonly when: 'before' | 'after';
}

/** After the first grant hold `holdCoveringGrants` sends (the decider's own, before the fix). */
export const afterFirstGrantHold: PauseAt = {
  at: (sql) => sql.includes('with recursive chain') && sql.includes('for share'),
  when: 'after',
};

/** Before `acquire`'s first lock, the decision chain: every authority hold is taken by then. */
export const beforeTheRuntimeSet: PauseAt = {
  at: (sql) => sql.includes('pg_advisory_xact_lock'),
  when: 'before',
};

/** The decider manages access, so `access.end` is theirs to run. */
export async function letDeciderEndAccess(s: Schedules): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage', undefined, false, 'access');
  });
}

function pausing(tx: TenantQuery, pause: PauseAt, reached: () => void, held: Promise<void>) {
  let paused = false;
  const stop = async (sql: string): Promise<void> => {
    if (paused || !pause.at(sql)) return;
    paused = true;
    reached();
    await held;
  };
  const intercepted: TenantQuery = {
    businessId: tx.businessId,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      if (pause.when === 'before') await stop(sql);
      const answer = await tx.query<Row>(sql, parameters);
      if (pause.when === 'after') await stop(sql);
      return answer;
    },
  };
  return intercepted;
}

/** Escalate the gate to `recipientPersonId` on `database`, paused where `pause` says. */
async function escalateOn(
  s: Schedules,
  database: Database,
  version: Detail,
  recipientPersonId: string,
  pause: PauseAt & { readonly reached: () => void; readonly held: Promise<void> },
): Promise<string> {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key in the fixture');
  const decided = await database.withBusiness(
    s.business,
    async (tx) =>
      await decide(pausing(tx, pause, pause.reached, pause.held), {
        gateId: String(version['gateId']),
        versionId: String(version['versionId']),
        decidedByPersonId: s.decider.personId,
        decidedByActorId: s.decider.actorId,
        subjects: [
          { kind: 'person', id: s.decider.personId },
          { kind: 'actor', id: s.decider.actorId },
        ],
        collection: 'task',
        decision: 'escalate',
        note: 'escalate at the bound',
        signingKey,
        capId: s.capId,
        recipientPersonId,
      }),
  );
  return decided.ok ? 'applied' : decided.refusal.code;
}

/** Whether a backend parks on a row lock in `table` before `finished` says it went through. */
export async function parkedOn(
  s: Schedules,
  table: string,
  finished: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (finished()) return false;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    const parked = await scalar(
      s,
      `select count(distinct a.pid)::text as n
         from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and l.locktype = 'tuple'
         join pg_class c on c.oid = l.relation
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and c.relname = $1`,
      [table],
    );
    if (parked > 0) return true;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

const deadlocks = async (s: Schedules): Promise<number> =>
  await scalar(
    s,
    `select deadlocks::text as n from pg_stat_database where datname = current_database()`,
    [],
  );

async function backends(s: Schedules): Promise<readonly number[]> {
  const found = await rows<{ readonly pid: number }>(
    s,
    `select pid from pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
        and pid <> pg_backend_pid()`,
    [],
  );
  return found.map((row) => row.pid);
}

/** Wait until every backend outside `before` has exited, its counts flushed. */
async function awaitExited(s: Schedules, before: readonly number[]): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    const now = await backends(s);
    if (now.every((pid) => before.includes(pid))) return;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('the racing backends never exited');
}

const outcome = (settled: PromiseSettledResult<string>): string =>
  settled.status === 'fulfilled' ? settled.value : `threw ${String(settled.reason)}`;

/** `access.end` of `personId` on a backend of its own, through the command entry. */
function endAccessElsewhere(s: Schedules, personId: string) {
  const database = racer(s);
  let finished = false;
  const done = asPerson(
    s,
    { command: 'access.end', operationId: randomUUID(), holderId: personId },
    database,
  )
    .then(codeOf)
    .finally(async () => {
      finished = true;
      await database.close();
    });
  done.catch(() => null);
  return { done, finished: () => finished };
}

/** What the race came to. `deadlocks` is how many the server counted while it ran. */
export interface Raced {
  readonly parked: boolean;
  readonly escalation: string;
  readonly accessEnd: string;
  readonly deadlocks: number;
}

/**
 * Escalate to `recipient`, paused at `pause`; `access.end(recipient)` on
 * another backend until it parks on `table` or commits; resume.
 */
export async function raceAccessEnd(
  s: Schedules,
  version: Detail,
  recipient: Member,
  pause: PauseAt,
  table: string,
): Promise<Raced> {
  const before = await backends(s);
  const counted = await deadlocks(s);
  const escalating = racer(s);
  const reached = barrier();
  const resume = barrier();
  const escalation = escalateOn(s, escalating, version, recipient.personId, {
    ...pause,
    reached: reached.release,
    held: resume.held,
  }).finally(async () => {
    await escalating.close();
  });
  escalation.catch(() => null);
  await reached.held;
  const ending = endAccessElsewhere(s, recipient.personId);
  const parked = await parkedOn(s, table, ending.finished);
  resume.release();
  const [escalated, ended] = await Promise.allSettled([escalation, ending.done]);
  await awaitExited(s, before);
  return {
    parked,
    escalation: outcome(escalated),
    accessEnd: outcome(ended),
    deadlocks: (await deadlocks(s)) - counted,
  };
}
