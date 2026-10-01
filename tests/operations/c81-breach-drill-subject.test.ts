// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the breach drill's template subject line, through the real API. The
// subject is part of the notice, so a placeholder in it is filled like one in
// the body, and one the drill cannot fill is `BREACH_TEMPLATE_UNFILLED` 409
// (docs/local/API.md): a notice with a hole in it is never drafted. The world
// is `c81-breach-drill-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  closeDrill,
  drill,
  harness,
  incident,
  noticesOf,
  openDrill,
  publishRunbook,
  record,
  runbookWords,
} from './c81-breach-drill-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-breach-drill-subject: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openDrill('c81_drill_subject');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeDrill();
});

const SUBJECT = '> Subject: A privacy incident involving your information';

/** Made-up runbook words whose template subject line reads `subject`. */
const withSubject = (subject: string): string => {
  const words = runbookWords(randomUUID());
  expect(words, 'the made-up runbook carries the subject line').toContain(SUBJECT);
  return words.replace(SUBJECT, `> Subject: ${subject}`);
};

describe.skipIf(serverUrl === undefined)('C81 the breach drill', () => {
  it('C81 breach drill subject: a placeholder the drill cannot fill in the subject drafts nothing, BREACH_TEMPLATE_UNFILLED 409', async () => {
    const incidentId = await record(incident(2));
    const ada = harness.world.ada.token;
    await publishRunbook('2.0', ada, 'alpha', withSubject('About `<unknown>`'));

    const unfilled = await drill(incidentId);
    expect(
      { status: unfilled.status, code: unfilled.code },
      'a subject with a hole is never drafted',
    ).toEqual({ status: 409, code: 'BREACH_TEMPLATE_UNFILLED' });
    expect(noticesOf(unfilled)).toEqual([]);
  });

  it('C81 breach drill subject: a date placeholder in the subject is filled with the day found', async () => {
    const sent = incident(3);
    const incidentId = await record(sent);
    const ada = harness.world.ada.token;
    await publishRunbook('2.1', ada, 'alpha', withSubject('A privacy incident found on `<date>`'));

    const drafted = await drill(incidentId);
    expect(drafted.status).toBe(200);
    const notices = noticesOf(drafted);
    expect(notices.length).toBe(3);
    for (const notice of notices) {
      expect(notice.subject, 'the subject carries the day found, filled').toBe(
        `A privacy incident found on ${sent.foundAt.slice(0, 10)}`,
      );
      expect(notice.subject, 'no placeholder is left in the subject').not.toContain('<');
    }
  });

  it('C81 breach drill subject: a line break typed into a value filling the subject becomes a space, and the body keeps it', async () => {
    const incidentId = await record(incident(4));
    const ada = harness.world.ada.token;
    await publishRunbook('2.2', ada, 'alpha', withSubject('What to do: `<steps>`'));

    const steps = 'Change your password.\r\nWatch your mail.\nCall us';
    const drafted = await drill(incidentId, { steps });
    expect(drafted.status).toBe(200);
    for (const notice of noticesOf(drafted)) {
      expect(notice.subject, 'the subject is one line').toBe(
        'What to do: Change your password. Watch your mail. Call us',
      );
      expect(notice.body, 'the body keeps the lines as typed').toContain(steps);
    }
  });
});
