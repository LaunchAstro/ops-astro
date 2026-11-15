// SPDX-License-Identifier: AGPL-3.0-only
//
// The breach drill's notices, drafted from the runbook template without a
// database. A notice is dated on the business's own clock, so a find made on
// an Australian morning carries that morning's date, not the UTC day before.
// Each affected person's notice describes only what concerns that person: the
// words the operator typed reach it with every other affected person's name
// and address taken out, while the OAIC's statement keeps them whole.

import { describe, expect, it } from 'vitest';
import { draftBreachNotices } from '../../packages/core-records/src/operations/breach-notices.ts';
import type { PrivacyIncident } from '../../packages/core-records/src/operations/privacy-incidents.ts';

const RUNBOOK = [
  '# Data breach runbook',
  '',
  '## Template: notice to affected people',
  '',
  '> Subject: A privacy incident found on `<date>`',
  '> Dear `<name>`,',
  '>',
  '> **What happened:** on `<date>` we found that `<plain description: what, how, when>`.',
  '> **Information involved:** `<kinds>`.',
  '> **What we have done:** `<containment and changes>`.',
  '> **What we recommend you do:** `<steps>`.',
  '',
].join('\n');

const incidentOf = (whatHappened: string, foundAt: Date): PrivacyIncident => ({
  id: '00000000-0000-4000-8000-000000000001',
  whatHappened,
  foundAt,
  foundBy: 'The second operator',
  affected: 'Two customers of one client.',
  informationKinds: ['contact', 'financial'],
  assessBy: new Date(foundAt.getTime() + 30 * 24 * 60 * 60 * 1000),
  overdue: false,
  status: 'open',
  recordedAt: foundAt,
  recordedByActorId: '00000000-0000-4000-8000-000000000002',
});

const OAIC = { name: 'The OAIC', address: 'oaic@example.test' };
const ALEX = { name: 'Alex Rivera', address: 'alex.rivera@example.test' };
const SAM = { name: 'Sam Okafor', address: 'sam@example.test' };

describe('breach notices drafted from the runbook template: the date', () => {
  it('a breach found on an Australian morning is dated that morning, not the UTC day before', () => {
    // 21:30 UTC on 12 October is 07:30 on 13 October in Australia.
    const foundAt = new Date('2026-10-12T21:30:00Z');
    const notices = draftBreachNotices(RUNBOOK, {
      incident: incidentOf('A folder link reached the wrong inbox.', foundAt),
      oaic: OAIC,
      people: [ALEX],
      containment: 'The link was withdrawn.',
      steps: 'Watch for odd mail.',
    });
    expect(notices, 'the template is filled').toBeDefined();
    for (const notice of notices ?? []) {
      expect(notice.subject).toBe('A privacy incident found on 2026-10-13');
      expect(notice.body).toContain('on 2026-10-13 we found that');
      expect(notice.body).not.toContain('2026-10-12');
    }
  });
});

describe('breach notices drafted from the runbook template: the people named', () => {
  it("each affected person's notice names no other affected person, and the OAIC's statement keeps every name", () => {
    const whatHappened =
      "Alex Rivera's invoice was emailed to sam@example.test, and SAM OKAFOR's to alex.rivera@example.test.";
    const notices = draftBreachNotices(RUNBOOK, {
      incident: incidentOf(whatHappened, new Date('2026-10-12T01:00:00Z')),
      oaic: OAIC,
      people: [ALEX, SAM],
      containment: 'We asked Sam Okafor and Alex Rivera to delete the copies.',
      steps: 'Write to us if Alex Rivera or Sam Okafor contacts you.',
    });
    expect(notices?.map((notice) => notice.name)).toEqual([OAIC.name, ALEX.name, SAM.name]);
    const [oaic, alex, sam] = notices ?? [];

    expect(oaic?.body, "the OAIC's statement carries the words whole").toContain(whatHappened);

    expect(alex?.body).toContain(`Dear ${ALEX.name},`);
    expect(alex?.body, "Alex's notice keeps what concerns Alex").toContain(
      "Alex Rivera's invoice was emailed to another person",
    );
    expect(alex?.body.toLowerCase(), "Alex's notice names no other person").not.toContain('sam');

    expect(sam?.body).toContain(`Dear ${SAM.name},`);
    expect(sam?.body, "Sam's notice keeps what concerns Sam").toContain(
      "another person's invoice was emailed to sam@example.test, and SAM OKAFOR's to another person",
    );
    expect(sam?.body.toLowerCase(), "Sam's notice names no other person").not.toContain('alex');
  });

  it('a name inside a longer word is left alone', () => {
    const notices = draftBreachNotices(RUNBOOK, {
      incident: incidentOf('Also, Alberta records were exposed.', new Date('2026-10-12T01:00:00Z')),
      oaic: OAIC,
      people: [ALEX, { name: 'Al', address: 'al@example.test' }],
      containment: 'The link was withdrawn.',
      steps: 'Watch for odd mail.',
    });
    expect(notices?.[1]?.body).toContain('Also, Alberta records were exposed.');
  });
});
