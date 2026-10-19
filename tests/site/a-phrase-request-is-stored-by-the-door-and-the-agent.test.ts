// SPDX-License-Identifier: AGPL-3.0-only
//
// #1987 (spec #1994): the request's wire shape is unchanged, and its two texts
// may be a phrase or a sentence. The person's door and the agent's request
// each store a heading rewrite `locating`, the texts as sent; the agent's
// replay of the same operation answers the same correction; and a phrase over
// two lines is refused with nothing stored, its fix line saying what is asked.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { PAGE, c80World, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Phrase request: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('phrase');
}, 120_000);

const HEADING = 'We are a friendly studio, here to help.';
const REWRITE = 'A welcoming studio that answers the phone.';

const asked = (taskId: string, word = HEADING, replacement = REWRITE) => ({
  command: 'live_correction.request',
  taskId,
  page: PAGE,
  word,
  replacement,
});

const texts = async (id: string) =>
  (
    await w.world.db.admin.execute<{ readonly word: string; readonly replacement: string }>(
      'select word, replacement from public.live_corrections where id = $1',
      [id],
    )
  )[0];

const stored = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

describe.skipIf(serverUrl === undefined)('a phrase request', () => {
  it('is stored locating by the person’s door, the texts as sent', async () => {
    const answer = await w.asRaw(w.ava, asked(w.taskA));
    if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
    expect(answer.detail['state']).toBe('locating');
    expect(await texts(String(answer.detail['correctionId']))).toStrictEqual({
      word: HEADING,
      replacement: REWRITE,
    });
  });

  it('is stored by the agent’s request, and its replay answers the same correction', async () => {
    const picked = await w.pickUpUnder(w.ava, `phrase ${randomUUID()}`, w.partyA);
    const sent = { ...asked(picked.taskId), operationId: randomUUID() };
    const first = detailOf(await w.world.asAgent(sent, picked.credential));
    const correctionId = String(first['correctionId']);
    expect(first['state']).toBe('locating');
    expect(await texts(correctionId)).toStrictEqual({ word: HEADING, replacement: REWRITE });
    const again = await w.world.asAgent(sent, picked.credential);
    expect(detailOf(again)['correctionId']).toBe(correctionId);
    expect(await stored(picked.taskId)).toBe(1);
  });

  it('refuses a phrase over two lines with nothing stored, saying what may be asked', async () => {
    const before = await stored(w.taskA);
    const answer = await w.asRaw(w.ava, asked(w.taskA, 'We are a friendly\nstudio', REWRITE));
    expect(codeOf(answer)).toBe('CHANGE_ENVELOPE_EXCEEDED');
    expect(JSON.stringify(answer)).toContain('one phrase or sentence on one line');
    expect(await stored(w.taskA)).toBe(before);
  });
});
