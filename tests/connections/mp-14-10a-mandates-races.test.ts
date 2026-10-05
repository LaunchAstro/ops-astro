// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a, the command half's races and isolation crossings, over HTTP
// against a real database (`mandates-world.ts`). Every race runs on a pool of
// its own, two connections wide, its transactions paused after C59's step-up
// clock read (after the envelope's grant check, before the command's first
// lock) so the other request lands exactly there. The isolation cases cross
// into rows that exist: each business has a client and a live mandate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import {
  AUD,
  buildMandatesWorld,
  detail,
  gate,
  inDays,
  RECORD_CANARY,
  type MandatesWorld,
} from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a mandate command races and isolation', () => {
  let w: MandatesWorld;

  const revision = async (table: string, id: string): Promise<number> =>
    await w.controls.count(`select revision as n from public.${table} where id = $1`, [id]);
  const live = async (): Promise<number> =>
    await w.controls.count(
      'select count(*) as n from public.standing_mandates where revoked_at is null',
      [],
    );

  /** Two requests on separate connections, both held after the step-up read until both reach it. */
  const together = async (
    run: (via: ReturnType<MandatesWorld['pausedApi']>) => readonly Promise<Answer>[],
  ): Promise<{ readonly answers: readonly Answer[]; readonly met: number }> => {
    let reached = 0;
    let met = 0;
    const both = gate();
    const via = w.pausedApi(2, async () => {
      reached += 1;
      if (reached >= 2) both.open();
      await both.wait();
      met = Math.max(met, reached);
    });
    const answers = await Promise.all(run(via)).finally(via.close);
    return { answers, met };
  };

  beforeAll(async () => {
    w = await buildMandatesWorld('mp1410ar');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('MP-14-10a two promotes at once on separate connections make one mandate', async () => {
    const before = await live();
    const body = { classId: w.cls['aPost'], ceiling: AUD(700), expiresAt: inDays(5) };
    const { answers, met } = await together((via) => [
      via.as(w.admin, 'graduation.promote', body),
      via.as(w.admin, 'graduation.promote', body),
    ]);
    expect(met).toBe(2);
    expect(answers.map((one) => one.status).toSorted()).toStrictEqual([200, 409]);
    expect(await live()).toBe(before + 1);
    expect(await revision('graduation_classes', String(w.cls['aPost']))).toBe(2);
  });

  it('MP-14-10a two revokes at once revoke once', async () => {
    const filed = await w.file(w.admin, { label: 'Race revoke' });
    const mandateId = String(detail(filed)['mandateId']);
    const { answers, met } = await together((via) => [
      via.as(w.admin, 'mandate.revoke', { mandateId }),
      via.as(w.admin, 'mandate.revoke', { mandateId }),
    ]);
    expect(met).toBe(2);
    expect(answers.map((one) => one.status).toSorted()).toStrictEqual([200, 409]);
    expect(await revision('standing_mandates', mandateId)).toBe(2);
  });

  it('MP-14-10a a revoke landing mid-command (between the check and the write) wins: nothing files on a revoked mandate or a revoked grant', async () => {
    // A mandate revoked while a demote of the class it promotes is past its
    // grant check: the demote finds it revoked and writes nothing.
    const promoted = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aLike'],
      ceiling: AUD(300),
      expiresAt: inDays(5),
    });
    expect(promoted.status).toBe(200);
    const mandateId = String(detail(promoted)['mandateId']);
    let landed: Answer | undefined;
    const demoting = w.pausedApi(2, async () => {
      landed = await w.as(w.admin, 'mandate.revoke', { mandateId });
    });
    const demote = await demoting
      .as(w.admin, 'graduation.demote', { classId: w.cls['aLike'] })
      .finally(demoting.close);
    expect(landed?.status).toBe(200);
    expect([demote.status, demote.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    expect(await revision('standing_mandates', mandateId)).toBe(2);
    // Promote stepped it to 2, the revoke to 3; the refused demote not at all.
    expect(await revision('graduation_classes', String(w.cls['aLike']))).toBe(3);

    // The filer's own mandate:manage grant revoked at the same point: the
    // command asks it again under its locks and files nothing.
    const before = await w.mandateRows();
    let revokedAt: Date | null = null;
    const filing = w.pausedApi(2, async () => {
      revokedAt = await w.controls.fixture.db.app.withBusiness(
        w.alpha,
        async (tx) => await revokeGrant(tx, w.racerGrant),
      );
    });
    const filed = await filing
      .as(w.racer, 'mandate.file', {
        clientId: w.clientA,
        classes: ['social.post'],
        ceiling: AUD(1),
        expiresAt: inDays(1),
        label: 'Filed as the grant goes',
      })
      .finally(filing.close);
    expect(revokedAt).not.toBeNull();
    expect([filed.status, filed.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(await w.mandateRows()).toBe(before);
  });

  it('MP-14-10a isolation: another business changes nothing of ours, and we change nothing of theirs', async () => {
    const before = await w.snapshot();
    const crossings: readonly [string, Record<string, unknown>][] = [
      ['mandate.revoke', { mandateId: w.seeded.alphaB }],
      ['graduation.promote', { classId: w.cls['bPost'], ceiling: AUD(1), expiresAt: inDays(1) }],
      ['graduation.demote', { classId: w.cls['bPost'] }],
      [
        'mandate.file',
        {
          clientId: w.clientB,
          classes: ['social.post'],
          ceiling: AUD(1),
          expiresAt: inDays(1),
          label: 'x',
        },
      ],
    ];
    for (const [name, body] of crossings) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.as(w.bravoAdmin, name, body, 'bravo');
      expect([answer.status, answer.body['code']], name).toStrictEqual([404, 'NOT_FOUND']);
      expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
    const ours = await w.as(w.admin, 'mandate.revoke', { mandateId: w.seeded.bravo });
    const theirClass = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['bravoPost'],
      ceiling: AUD(1),
      expiresAt: inDays(1),
    });
    const theirClient = await w.file(w.admin, { clientId: w.bravoClient });
    for (const answer of [ours, theirClass, theirClient]) {
      expect([answer.status, answer.body['code']]).toStrictEqual([404, 'NOT_FOUND']);
    }
    expect(await w.snapshot()).toBe(before);
  });

  it('MP-14-10a isolation: a client-scoped holder never touches another client', async () => {
    const before = await w.snapshot();
    const onB = [
      w.as(w.clientManager, 'mandate.revoke', { mandateId: w.seeded.alphaB }),
      w.as(w.clientManager, 'graduation.demote', { classId: w.cls['bPost'] }),
      w.file(w.clientManager, { clientId: w.clientB }),
    ];
    for (const answer of await Promise.all(onB)) {
      expect([answer.status, answer.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
      expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
    expect(await w.snapshot()).toBe(before);
  });

  it('MP-14-10a isolation: an agent under a live delegation changes nothing', async () => {
    const task = await w.controls.createTask('agent crossing');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const credential = String(picked['credential']);
    const before = await w.snapshot();
    for (const [name, body] of [
      ['mandate.revoke', { mandateId: w.seeded.alphaB }],
      ['graduation.promote', { classId: w.cls['aShare'], ceiling: AUD(1), expiresAt: inDays(1) }],
      ['graduation.demote', { classId: w.cls['aPost'] }],
      [
        'mandate.file',
        {
          clientId: w.clientA,
          classes: ['social.post'],
          ceiling: AUD(1),
          expiresAt: inDays(1),
          label: 'x',
        },
      ],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.controls.asAgent(name, body, credential);
      expect(answer.status, name).toBe(403);
      expect(String(answer.body['code']), name).toMatch(/^(DELEGATION_|AUTH_|SCOPE_)/u);
    }
    expect(await w.snapshot()).toBe(before);
  });
});
