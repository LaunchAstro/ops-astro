// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one world, the read-then-writes of one filing */
//
// Every read-then-write in a standing mandate filing (#1427), attacked over
// HTTP and on raw connections against a real database (`mandates-world.ts`).
// The filing locks the client, asks its grant again, reads the draft's bound
// mandate, looks up an identical live one, inserts, binds, waits on the audit
// chain's lock (`standsAtCommit`) and, for a repeat, checks the mandate is
// still live. Each step meets another transaction on a separate connection,
// a crash (the transaction aborts there), and a lost answer retried under its
// operation and under a fresh one with its draft. The trigger
// `standing_mandates_one_live_filing` is raced directly on two connections
// under read committed; its Repeatable Read race has a file of its own,
// `a-live-standing-mandate-is-filed-once-under-repeatable-read.test.ts`.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import {
  AUD,
  buildMandatesWorld,
  detail,
  gate,
  inDays,
  type MandatesWorld,
} from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const LOOKUP = 'standing_mandate_live_filing';
const INSERT = 'insert into public.standing_mandates as m';
const BIND = 'insert into public.standing_mandate_drafts';
/** `mandateStillLive`, the repeat's read once the last wait is over. */
const STILL_LIVE = 'm.client_id = $1 and m.id = $2';

const mandateOf = (answer: Answer): string => String(detail(answer)['mandateId']);
const outcome = (answer: Answer): readonly unknown[] => [
  answer.status,
  answer.body['code'],
  answer.body['names'],
];

type Body = Readonly<Record<string, unknown>>;

const codeOf = (settled: PromiseSettledResult<void>): string =>
  settled.status === 'fulfilled'
    ? 'ok'
    : String((settled.reason as { readonly code?: unknown }).code);

describe.skipIf(serverUrl === undefined)(
  'a standing mandate filing files once through races, crashes and lost answers',
  () => {
    let w: MandatesWorld;
    let labels = 0;

    /** One complete filing for Client A, its expiry fixed, under a label no other case uses. */
    const payload = (overrides: Body = {}) => ({
      clientId: w.clientA,
      draftId: randomUUID(),
      classes: ['social.post'],
      ceiling: AUD(31_000),
      expiresAt: inDays(21),
      label: `Posts for A, race case ${(labels += 1)} ${randomUUID()}`,
      ...overrides,
    });
    const fileAs = async (body: Body, who: Member = w.admin): Promise<Answer> =>
      await w.as(who, 'mandate.file', body);
    const rowsLabelled = async (label: unknown): Promise<number> =>
      await w.controls.count(
        'select count(*) as n from public.standing_mandates where label = $1',
        [label],
      );
    const liveLabelled = async (label: unknown): Promise<number> =>
      await w.controls.count(
        `select count(*) as n from public.standing_mandates
          where label = $1 and revoked_at is null`,
        [label],
      );
    const bindings = async (draftId: unknown): Promise<number> =>
      await w.controls.count(
        'select count(*) as n from public.standing_mandate_drafts where draft_id = $1',
        [draftId],
      );
    const boundTo = async (draftId: unknown): Promise<string | undefined> => {
      const rows = await w.controls.fixture.db.admin.execute<{ readonly mandate_id: string }>(
        'select mandate_id from public.standing_mandate_drafts where draft_id = $1',
        [draftId],
      );
      return rows[0]?.mandate_id;
    };

    /** Whether, within `ms`, a backend of this database is parked on a lock. */
    const blockedOnLock = async (ms = 5000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polled until it waits or the deadline
        const found = await w.controls.fixture.db.admin.execute(
          `select 1 from pg_stat_activity
            where datname = current_database() and state = 'active'
              and wait_event_type = 'Lock'`,
        );
        if (found.length > 0) return true;
        // eslint-disable-next-line no-await-in-loop -- polled
        await delay(25);
      }
      return false;
    };

    /** Two requests on separate connections, both held after the step-up read until both reach it. */
    const together = async (
      run: (via: ReturnType<MandatesWorld['pausedApi']>) => readonly Promise<Answer>[],
    ): Promise<{ readonly answers: readonly Answer[]; readonly met: number }> => {
      let reached = 0;
      let met = Number.POSITIVE_INFINITY;
      const both = gate();
      const via = w.pausedApi(2, async () => {
        reached += 1;
        if (reached >= 2) both.open();
        await both.wait();
        met = Math.min(met, reached);
      });
      const answers = await Promise.all(run(via)).finally(via.close);
      return { answers, met };
    };

    /** One filing on a pool of its own, its transaction aborted just after `statement`. */
    const crashedAfter = async (statement: string, body: Body): Promise<Answer> => {
      let crashed = 0;
      const via = w.pausedApi(
        1,
        async () => {
          crashed += 1;
          await Promise.reject(new Error(`the filing's process died after ${statement}`));
        },
        statement,
      );
      const answer = await via.as(w.admin, 'mandate.file', body).finally(via.close);
      expect(crashed).toBe(1);
      return answer;
    };

    /** A member who holds mandate:manage business-wide on a grant of their own. */
    const manager = async (name: string): Promise<{ who: Member; grant: string }> => {
      const app = w.controls.fixture.db.app;
      const who = await enrol(app, w.alpha, name);
      const grant = await app.withBusiness(w.alpha, async (tx) => {
        await grantTo(tx, who, 'read', { kind: 'business', id: null }, false, 'connection');
        return await grantTo(tx, who, 'manage', { kind: 'business', id: null }, false, 'mandate');
      });
      return { who, grant };
    };

    beforeAll(async () => {
      w = await buildMandatesWorld('mandrace');
    }, 120_000);

    afterAll(async () => {
      await w?.drop();
    });

    describe('two transactions at once on separate connections', () => {
      it('a revoke of the matched mandate landing between the content lookup and the last wait waits for the repeat, and the draft is refused after', async () => {
        const first = payload();
        const filed = await fileAs(first);
        expect(filed.status).toBe(200);
        const repeat = { ...first, draftId: randomUUID() };
        let revoking: Promise<Answer> | undefined;
        let waited = false;
        const via = w.pausedApi(
          1,
          async () => {
            revoking = w.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(filed) });
            waited = await blockedOnLock();
          },
          LOOKUP,
        );
        const answer = await via.as(w.admin, 'mandate.file', repeat).finally(via.close);
        const revoked = await revoking;
        expect(waited).toBe(true);
        expect([answer.status, mandateOf(answer), detail(answer)['repeat']]).toStrictEqual([
          200,
          mandateOf(filed),
          true,
        ]);
        expect(revoked?.status).toBe(200);
        expect(await boundTo(repeat.draftId)).toBe(mandateOf(filed));
        const retried = await fileAs(repeat);
        expect(outcome(retried)).toStrictEqual([
          409,
          'TRANSITION_NOT_PERMITTED',
          ['state=revoked'],
        ]);
        expect(await rowsLabelled(first.label)).toBe(1);
        expect(await liveLabelled(first.label)).toBe(0);
      });

      it('a retry of a bound draft and a revoke of its mandate at once settle in one order and leave no authority live', async () => {
        const body = payload();
        const filed = await fileAs(body);
        expect(filed.status).toBe(200);
        const { answers, met } = await together((via) => [
          via.as(w.admin, 'mandate.file', body),
          via.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(filed) }),
        ]);
        const [retry, revoke] = answers as [Answer, Answer];
        expect(met).toBe(2);
        expect(revoke.status).toBe(200);
        const settled =
          retry.status === 200
            ? [retry.status, mandateOf(retry), detail(retry)['repeat']]
            : outcome(retry);
        expect([
          [200, mandateOf(filed), true],
          [409, 'TRANSITION_NOT_PERMITTED', ['state=revoked']],
        ]).toContainEqual(settled);
        expect(await rowsLabelled(body.label)).toBe(1);
        expect(await liveLabelled(body.label)).toBe(0);
        expect(await bindings(body.draftId)).toBe(1);
      });

      it('a second draft of identical content files anew when the first mandate is revoked while it waits for the client', async () => {
        const first = payload();
        const filed = await fileAs(first);
        expect(filed.status).toBe(200);
        const second = { ...first, draftId: randomUUID() };
        let revoked: Answer | undefined;
        const via = w.pausedApi(1, async () => {
          revoked = await w.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(filed) });
        });
        const answer = await via.as(w.admin, 'mandate.file', second).finally(via.close);
        expect(revoked?.status).toBe(200);
        expect(answer.status).toBe(200);
        expect(detail(answer)['repeat']).toBeUndefined();
        expect(mandateOf(answer)).not.toBe(mandateOf(filed));
        expect(await boundTo(second.draftId)).toBe(mandateOf(answer));
        expect(await rowsLabelled(first.label)).toBe(2);
        expect(await liveLabelled(first.label)).toBe(1);
      });

      it('one draft filed for two clients at once files one mandate for each, each bound within its client', async () => {
        const body = payload();
        const { answers, met } = await together((via) => [
          via.as(w.admin, 'mandate.file', body),
          via.as(w.admin, 'mandate.file', { ...body, clientId: w.clientB }),
        ]);
        const [forA, forB] = answers as [Answer, Answer];
        expect(met).toBe(2);
        expect([forA.status, forB.status]).toStrictEqual([200, 200]);
        expect(mandateOf(forA)).not.toBe(mandateOf(forB));
        const bound = await w.controls.fixture.db.admin.execute<{
          readonly client_id: string;
          readonly mandate_id: string;
          readonly owner: string;
        }>(
          `select d.client_id, d.mandate_id, m.client_id as owner
             from public.standing_mandate_drafts d
             join public.standing_mandates m on m.id = d.mandate_id
            where d.draft_id = $1 order by d.client_id = $2 desc`,
          [body.draftId, w.clientA],
        );
        expect(bound.map((one) => [one.client_id, one.mandate_id, one.owner])).toStrictEqual([
          [w.clientA, mandateOf(forA), w.clientA],
          [w.clientB, mandateOf(forB), w.clientB],
        ]);
      });

      it('one draft sent at once with two different values files once and refuses the other naming the draft', async () => {
        const body = payload();
        const { answers, met } = await together((via) => [
          via.as(w.admin, 'mandate.file', body),
          via.as(w.admin, 'mandate.file', { ...body, ceiling: AUD(32_000) }),
        ]);
        expect(met).toBe(2);
        expect(answers.map((one) => one.status).toSorted()).toStrictEqual([200, 422]);
        const refused = answers.find((one) => one.status === 422) as Answer;
        expect(outcome(refused)).toStrictEqual([422, 'FIELD_VALUE_INVALID', ['draftId']]);
        expect(await rowsLabelled(body.label)).toBe(1);
        expect(await bindings(body.draftId)).toBe(1);
      });

      it('a grant revoke issued while a repeat waits to commit is held until it commits, and the holder is refused after', async () => {
        const { who, grant } = await manager('mandrace-holder');
        const first = payload();
        const filed = await fileAs(first, who);
        expect(filed.status).toBe(200);
        const repeat = { ...first, draftId: randomUUID() };
        let revoking: Promise<unknown> | undefined;
        let waited = false;
        const via = w.pausedApi(
          1,
          async () => {
            revoking = w.controls.fixture.db.app.withBusiness(
              w.alpha,
              async (tx) => await revokeGrant(tx, grant),
            );
            waited = await blockedOnLock();
          },
          LOOKUP,
        );
        const answer = await via.as(who, 'mandate.file', repeat).finally(via.close);
        await revoking;
        // The grant is held shared from the envelope's check to commit: its revoke waits.
        expect(waited).toBe(true);
        expect([answer.status, mandateOf(answer)]).toStrictEqual([200, mandateOf(filed)]);
        expect(await bindings(repeat.draftId)).toBe(1);
        const retried = await fileAs({ ...repeat, draftId: randomUUID() }, who);
        expect([retried.status, retried.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
        expect(await rowsLabelled(first.label)).toBe(1);
      });
    });

    describe('a crash at each step files nothing, and a retry of the draft files once', () => {
      const retriedOnce = async (
        body: Body & { readonly label: string; readonly draftId: string },
      ) => {
        expect(await rowsLabelled(body.label)).toBe(0);
        expect(await bindings(body.draftId)).toBe(0);
        const again = await fileAs(body);
        const fresh = await fileAs({ ...body, operationId: randomUUID() });
        expect([again.status, fresh.status]).toStrictEqual([200, 200]);
        expect(mandateOf(fresh)).toBe(mandateOf(again));
        expect(await rowsLabelled(body.label)).toBe(1);
        expect(await bindings(body.draftId)).toBe(1);
      };

      it('aborted after the insert', async () => {
        const body = { ...payload(), operationId: randomUUID() };
        const crashed = await crashedAfter(INSERT, body);
        expect(crashed.status).not.toBe(200);
        await retriedOnce(body);
      });

      it('aborted after the bind', async () => {
        const body = { ...payload(), operationId: randomUUID() };
        const crashed = await crashedAfter(BIND, body);
        expect(crashed.status).not.toBe(200);
        await retriedOnce(body);
      });

      it('aborted after the content lookup found a live mandate', async () => {
        const first = payload();
        const filed = await fileAs(first);
        expect(filed.status).toBe(200);
        const repeat = { ...first, draftId: randomUUID(), operationId: randomUUID() };
        expect((await crashedAfter(LOOKUP, repeat)).status).not.toBe(200);
        expect(await bindings(repeat.draftId)).toBe(0);
        const again = await fileAs(repeat);
        expect([again.status, mandateOf(again), detail(again)['repeat']]).toStrictEqual([
          200,
          mandateOf(filed),
          true,
        ]);
        expect(await boundTo(repeat.draftId)).toBe(mandateOf(filed));
        expect(await rowsLabelled(first.label)).toBe(1);
      });

      it('aborted after the last wait, at the repeat’s liveness check', async () => {
        const first = payload();
        const filed = await fileAs(first);
        expect(filed.status).toBe(200);
        const repeat = { ...first, draftId: randomUUID(), operationId: randomUUID() };
        expect((await crashedAfter(STILL_LIVE, repeat)).status).not.toBe(200);
        expect(await bindings(repeat.draftId)).toBe(0);
        const again = await fileAs(repeat);
        expect([again.status, mandateOf(again)]).toStrictEqual([200, mandateOf(filed)]);
        expect(await bindings(repeat.draftId)).toBe(1);
        expect(await rowsLabelled(first.label)).toBe(1);
      });
    });

    describe('an answer lost after commit, retried, files nothing new', () => {
      const retriedTwice = async (
        body: Body & { readonly label: string; readonly draftId: string },
        mandateId: string,
      ) => {
        const rows = await rowsLabelled(body.label);
        const same = await fileAs(body);
        const fresh = await fileAs({ ...body, operationId: randomUUID() });
        expect([same.status, mandateOf(same)]).toStrictEqual([200, mandateId]);
        expect([fresh.status, mandateOf(fresh)]).toStrictEqual([200, mandateId]);
        expect(await rowsLabelled(body.label)).toBe(rows);
        expect(await bindings(body.draftId)).toBe(1);
      };

      it('a fresh filing, retried under its operation and under a fresh one with its draft', async () => {
        const body = { ...payload(), operationId: randomUUID() };
        const lost = await fileAs(body);
        expect(lost.status).toBe(200);
        await retriedTwice(body, mandateOf(lost));
        expect(await rowsLabelled(body.label)).toBe(1);
      });

      it('a repeat answered through another draft’s mandate, retried both ways', async () => {
        const first = payload();
        const filed = await fileAs(first);
        expect(filed.status).toBe(200);
        const repeat = { ...first, draftId: randomUUID(), operationId: randomUUID() };
        const lost = await fileAs(repeat);
        expect([lost.status, mandateOf(lost)]).toStrictEqual([200, mandateOf(filed)]);
        await retriedTwice(repeat, mandateOf(filed));
        expect(await rowsLabelled(first.label)).toBe(1);
      });

      it('one operation sent twice at once on two connections files once', async () => {
        const body = { ...payload(), operationId: randomUUID() };
        // The second is held on the operation's register row before the step-up
        // read, so the gate lets the first on alone; the two still overlap.
        const { answers } = await together((via) => [
          via.as(w.admin, 'mandate.file', body),
          via.as(w.admin, 'mandate.file', body),
        ]);
        const filed = answers.filter((one) => one.status === 200).map((one) => mandateOf(one));
        expect(filed.length).toBeGreaterThan(0);
        expect(new Set(filed).size).toBe(1);
        expect(await rowsLabelled(body.label)).toBe(1);
        expect(await bindings(body.draftId)).toBe(1);
      });
    });

    describe('the trigger standing_mandates_one_live_filing, raced directly', () => {
      /**
       * Two read committed transactions on two raw application connections,
       * each begun before either inserts. The first inserts `body` and is
       * held open until the second, inserting the same filing, is seen waiting
       * on a lock; then the first commits.
       */
      const insertBoth = async (
        body: ReturnType<typeof payload>,
      ): Promise<readonly [PromiseSettledResult<void>, PromiseSettledResult<void>, boolean]> => {
        const one = postgres(w.controls.fixture.db.appUrl, { max: 1, onnotice: () => {} });
        const two = postgres(w.controls.fixture.db.appUrl, { max: 1, onnotice: () => {} });
        const firstSnapshot = gate(10_000);
        const secondSnapshot = gate(10_000);
        const written = gate(10_000);
        const held = gate(10_000);
        const insert = async (tx: postgres.TransactionSql): Promise<void> => {
          await tx.unsafe(
            `insert into public.standing_mandates
               (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
                label, authored_by_actor_id)
             values ((select public.app_business_id()), gen_random_uuid(), $1, $2::text[], false,
                     $3, 'AUD', $4, $5, $6)`,
            [
              body.clientId,
              body.classes,
              body.ceiling.amountMinor,
              body.expiresAt,
              body.label,
              w.admin.actorId,
            ],
          );
        };
        const first = one.begin(async (tx) => {
          await tx`select set_config('app.business_id', ${w.alpha}, true)`;
          firstSnapshot.open();
          await secondSnapshot.wait();
          await insert(tx);
          written.open();
          await held.wait();
        });
        const second = two.begin(async (tx) => {
          await tx`select set_config('app.business_id', ${w.alpha}, true)`;
          await tx`select count(*) from public.standing_mandates`;
          await firstSnapshot.wait();
          secondSnapshot.open();
          await written.wait();
          await insert(tx);
        });
        await written.wait();
        const waited = await blockedOnLock();
        held.open();
        const settled = await Promise.allSettled([first, second]);
        await one.end();
        await two.end();
        return [settled[0], settled[1], waited];
      };

      it('under read committed, the second of two identical inserts waits and is refused', async () => {
        const body = payload();
        const [first, second, waited] = await insertBoth(body);
        expect(waited).toBe(true);
        expect([codeOf(first), codeOf(second)]).toStrictEqual(['ok', '23505']);
        expect(await liveLabelled(body.label)).toBe(1);
      }, 30_000);

      it('a direct insert racing a filing past its insert waits for it and is refused', async () => {
        const body = payload();
        const direct = postgres(w.controls.fixture.db.appUrl, { max: 1, onnotice: () => {} });
        let inserting: Promise<string> | undefined;
        let waited = false;
        const via = w.pausedApi(
          1,
          async () => {
            inserting = direct
              .begin(async (tx) => {
                await tx`select set_config('app.business_id', ${w.alpha}, true)`;
                await tx.unsafe(
                  `insert into public.standing_mandates
                     (business_id, id, client_id, classes, refuses, ceiling_minor, currency,
                      expires_at, label, authored_by_actor_id)
                   values ((select public.app_business_id()), gen_random_uuid(), $1,
                           array['social.post'], false, $2, 'AUD', $3, $4, $5)`,
                  [
                    w.clientA,
                    body.ceiling.amountMinor,
                    body.expiresAt,
                    body.label,
                    w.admin.actorId,
                  ],
                );
              })
              .then(
                () => 'ok',
                (error: unknown) => String((error as { readonly code?: unknown }).code),
              );
            waited = await blockedOnLock();
          },
          INSERT,
        );
        const answer = await via.as(w.admin, 'mandate.file', body).finally(via.close);
        const code = await inserting;
        await direct.end();
        expect(waited).toBe(true);
        expect(answer.status).toBe(200);
        expect(code).toBe('23505');
        expect(await liveLabelled(body.label)).toBe(1);
      }, 30_000);
    });
  },
);
