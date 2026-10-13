// SPDX-License-Identifier: AGPL-3.0-only
//
// One standing mandate per filing (#1427), over HTTP against a real database
// (`mandates-world.ts`). A filing is told apart from a retry of it by its
// draft id, which the screen sends on every retry whatever operation id
// carries it, and by its content: an identical live mandate answers a filing
// with no binding yet. Every case builds one fixed payload and reuses it, and
// asserts its first filing succeeded before the repeat or refusal.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import {
  AUD,
  buildMandatesWorld,
  detail,
  gate,
  inDays,
  type MandatesWorld,
} from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return String((error as { readonly code?: unknown }).code);
  }
};

const mandateOf = (answer: Answer): string => String(detail(answer)['mandateId']);
const outcome = (answer: Answer): readonly unknown[] => [
  answer.status,
  answer.body['code'],
  answer.body['names'],
];

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('a repeated standing mandate filing files once', () => {
  let w: MandatesWorld;
  let labels = 0;

  /** One complete filing for Client A, its expiry fixed, under a label no other case uses. */
  const payload = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    clientId: w.clientA,
    draftId: randomUUID(),
    classes: ['social.post', 'social.reply'],
    ceiling: AUD(25_000),
    expiresAt: inDays(20),
    label: `Posts and replies for A, case ${(labels += 1)}`,
    ...overrides,
  });
  const fileAs = async (body: Readonly<Record<string, unknown>>): Promise<Answer> =>
    await w.as(w.admin, 'mandate.file', body);
  const rowsLabelled = async (label: unknown): Promise<number> =>
    await w.controls.count('select count(*) as n from public.standing_mandates where label = $1', [
      label,
    ]);

  /** Two filings on separate connections, both held after the step-up read until both reach it. */
  const together = async (
    bodies: readonly Readonly<Record<string, unknown>>[],
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
    const answers = await Promise.all(
      bodies.map(async (body) => await via.as(w.admin, 'mandate.file', body)),
    ).finally(via.close);
    return { answers, met };
  };

  beforeAll(async () => {
    w = await buildMandatesWorld('mandonce');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('two connections filing one identical payload under two drafts create one mandate', async () => {
    const body = payload();
    const { answers, met } = await together([body, { ...body, draftId: randomUUID() }]);
    expect(met).toBe(2);
    expect(answers.map((one) => one.status)).toStrictEqual([200, 200]);
    expect(mandateOf(answers[1] as Answer)).toBe(mandateOf(answers[0] as Answer));
    expect(await rowsLabelled(body.label)).toBe(1);
  });

  it('two connections filing one draft at once create one mandate', async () => {
    const body = payload();
    const { answers, met } = await together([body, body]);
    expect(met).toBe(2);
    expect(answers.map((one) => one.status)).toStrictEqual([200, 200]);
    expect(mandateOf(answers[1] as Answer)).toBe(mandateOf(answers[0] as Answer));
    expect(await rowsLabelled(body.label)).toBe(1);
  });

  it('a repeat answers with the first mandate and says it is a repeat', async () => {
    const body = payload();
    const first = await fileAs(body);
    expect(first.status).toBe(200);
    const again = await fileAs(body);
    expect([again.status, mandateOf(again), detail(again)['repeat']]).toStrictEqual([
      200,
      mandateOf(first),
      true,
    ]);
    // The same classes in another order are the same filing.
    const reordered = await fileAs({
      ...body,
      draftId: randomUUID(),
      classes: ['social.reply', 'social.post'],
    });
    expect([reordered.status, mandateOf(reordered)]).toStrictEqual([200, mandateOf(first)]);
    expect(await rowsLabelled(body.label)).toBe(1);
  });

  it('a lost filing, revoked, then retried under a fresh operation with its draft is refused', async () => {
    const body = payload();
    const lost = await fileAs(body);
    expect(lost.status).toBe(200);
    const revoked = await w.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(lost) });
    expect(revoked.status).toBe(200);
    const retried = await fileAs(body);
    expect(outcome(retried)).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED', ['state=revoked']]);
    expect(await rowsLabelled(body.label)).toBe(1);
  });

  it('a draft answered through another draft’s mandate is refused once that mandate is revoked', async () => {
    const a = payload();
    const b = { ...a, draftId: randomUUID() };
    const filed = await fileAs(a);
    expect(filed.status).toBe(200);
    const through = await fileAs(b);
    expect([through.status, mandateOf(through)]).toStrictEqual([200, mandateOf(filed)]);
    expect((await w.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(filed) })).status).toBe(
      200,
    );
    const retried = await fileAs(b);
    expect(outcome(retried)).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED', ['state=revoked']]);
    expect(await rowsLabelled(a.label)).toBe(1);
  });

  it('the same draft with other values is refused naming the draft', async () => {
    const body = payload();
    expect((await fileAs(body)).status).toBe(200);
    const changed = await fileAs({ ...body, ceiling: AUD(26_000) });
    expect(outcome(changed)).toStrictEqual([422, 'FIELD_VALUE_INVALID', ['draftId']]);
    expect(await rowsLabelled(body.label)).toBe(1);
  });

  it('a filing identical to a revoked mandate under a new draft files a new one', async () => {
    const body = payload();
    const first = await fileAs(body);
    expect((await w.as(w.admin, 'mandate.revoke', { mandateId: mandateOf(first) })).status).toBe(
      200,
    );
    const fresh = await fileAs({ ...body, draftId: randomUUID() });
    expect(fresh.status).toBe(200);
    expect(mandateOf(fresh)).not.toBe(mandateOf(first));
    expect(await rowsLabelled(body.label)).toBe(2);
  });

  it('a draft and payload filed for another client or business never answer with this client’s mandate', async () => {
    const body = payload({ classes: ['social.post'] });
    const ours = await fileAs(body);
    expect(ours.status).toBe(200);
    const forB = await fileAs({ ...body, clientId: w.clientB });
    expect(forB.status).toBe(200);
    expect(mandateOf(forB)).not.toBe(mandateOf(ours));
    const bravo = await w.as(
      w.bravoAdmin,
      'mandate.file',
      { ...body, clientId: w.bravoClient },
      'bravo',
    );
    expect(bravo.status).toBe(200);
    expect(mandateOf(bravo)).not.toBe(mandateOf(ours));
    expect(await rowsLabelled(body.label)).toBe(3);
  });

  it('labels that differ only past a long shared prefix, and twenty long classes, are told apart exactly', async () => {
    const stem = 'Posts for A '.repeat(40);
    const one = await fileAs(payload({ label: `${stem}one` }));
    const two = await fileAs(payload({ label: `${stem}two` }));
    expect([one.status, two.status]).toStrictEqual([200, 200]);
    expect(mandateOf(two)).not.toBe(mandateOf(one));
    const twenty = Array.from(
      { length: 20 },
      (_, n) => `social.k${String(n).padStart(2, '0')}${'x'.repeat(24)}`,
    );
    await w.controls.fixture.db.admin.execute(
      `insert into public.graduation_classes
         (business_id, id, client_id, action_class, class_label, earned)
       select $1, gen_random_uuid(), $2, word, word, 'short' from unnest($3::text[]) as word`,
      [w.alpha, w.clientA, twenty],
    );
    const wide = payload({ classes: twenty });
    const filed = await fileAs(wide);
    expect(filed.status).toBe(200);
    const again = await fileAs({ ...wide, draftId: randomUUID(), classes: twenty.toReversed() });
    expect([again.status, mandateOf(again)]).toStrictEqual([200, mandateOf(filed)]);
  });

  it('a mandate that expires while the repeat waits to commit is not answered as a repeat', async () => {
    const expiresAt = new Date(Date.now() + 4000).toISOString();
    const label = `Expiring for A ${randomUUID()}`;
    await w.controls.fixture.db.admin.execute(
      `insert into public.standing_mandates
         (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
          label, authored_by_actor_id)
       values ($1, gen_random_uuid(), $2, array['social.post'], false, 700, 'AUD', $3, $4, $5)`,
      [w.alpha, w.clientA, expiresAt, label, w.admin.actorId],
    );
    let paused = 0;
    const via = w.pausedApi(
      1,
      async () => {
        paused += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
      },
      'standing_mandate_live_filing',
    );
    const body = payload({ classes: ['social.post'], ceiling: AUD(700), expiresAt, label });
    const answer = await via.as(w.admin, 'mandate.file', body).finally(via.close);
    expect(paused).toBe(1);
    expect(outcome(answer)).toStrictEqual([422, 'FIELD_VALUE_INVALID', ['expiresAt']]);
    expect(await rowsLabelled(label)).toBe(1);
    expect(
      await w.controls.count(
        'select count(*) as n from public.standing_mandate_drafts where draft_id = $1',
        [body.draftId],
      ),
    ).toBe(0);
  }, 30_000);

  it('the database refuses a second live mandate and a binding to another client’s mandate', async () => {
    const body = payload();
    const filed = await fileAs(body);
    expect(filed.status).toBe(200);
    const app = w.controls.fixture.db.app;
    const duplicate = await codeOf(
      async () =>
        await app.withBusiness(w.alpha, async (tx) => {
          await tx.query(
            `insert into public.standing_mandates
               (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
                label, authored_by_actor_id)
             values ((select public.app_business_id()), gen_random_uuid(), $1,
                     array['social.reply', 'social.post'], false, 25000, 'AUD', $2, $3, $4)`,
            [w.clientA, body.expiresAt, body.label, w.admin.actorId],
          );
        }),
    );
    expect(duplicate).toBe('23505');
    const crossing = await codeOf(
      async () =>
        await app.withBusiness(w.alpha, async (tx) => {
          await tx.query(
            `insert into public.standing_mandate_drafts (business_id, client_id, draft_id, mandate_id)
             values ((select public.app_business_id()), $1, gen_random_uuid(), $2)`,
            [w.clientA, w.seeded.alphaB],
          );
        }),
    );
    expect(crossing).toBe('23503');
    expect(await rowsLabelled(body.label)).toBe(1);
  });
});
