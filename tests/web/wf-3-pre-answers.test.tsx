// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-3 (#636) with WF-6's pre-answers (#639): the map view draws charting's
// cited pre-answers in a section of their own, never among Decisions so far.
// Each line shows the question, the answer and its one source: a cited
// record by its key as a link, a reference as written, or "withheld" where
// the reader may not read the record, never its id. The look waits on W4 and
// MP-1-7 (`wf-3-held.test.tsx`). Pages over the composed API and the database.

/* eslint-disable max-lines-per-function -- one suite over one world */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { keyOf, openMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const SECTION = '[data-map-section="pre-answers"]';

describe.skipIf(serverUrl === undefined)('WF-3 the map view draws the pre-answers', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf3pre', 'wfthreepre');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  /** A resolved ticket on a map of its own: a recorded decision to cite. */
  async function decision(title: string): Promise<{ id: string; key: string; map: string }> {
    const charted = await w.as(lead, {
      command: 'map.chart',
      title: `${title} map`,
      tickets: [{ ref: 'd', title, type: 'research' }],
    });
    const map = must(charted, 'chart').id;
    const id = (charted as { detail?: { tickets?: Record<string, string> } }).detail?.tickets?.[
      'd'
    ] as string;
    must(await w.as(lead, { command: 'task.claim', ...(await at(id)) }), 'claim');
    must(
      await w.as(lead, {
        command: 'task.resolve',
        ...(await at(id)),
        answer: `${title} answer`,
        gist: `${title} gist`,
      }),
      'resolve',
    );
    return { id, key: await keyOf(w, id), map };
  }

  /** A map charted with three pre-answers: a cited record, a reference, a veto-open call. */
  async function mapWithPreAnswers(cited: string): Promise<{ id: string; key: string }> {
    const charted = await w.as(lead, {
      command: 'map.chart',
      title: 'pre-answered map',
      preAnswers: [
        { question: 'Which region?', answer: 'Sydney', source: { recordId: cited } },
        {
          question: 'Which licence?',
          answer: 'AGPL',
          source: { reference: 'the licence decision of 12 August' },
        },
        {
          question: 'Plain English?',
          answer: 'Yes',
          source: { reference: 'the house style' },
          vetoOpen: true,
        },
      ],
    });
    const id = must(charted, 'chart').id;
    return { id, key: await keyOf(w, id) };
  }

  const lines = (page: Mounted) => page.all(`${SECTION} li`);

  it('WF-3 the map view shows each pre-answer with its question, answer and source', async () => {
    const cited = await decision('region decision');
    const map = await mapWithPreAnswers(cited.id);
    const page = await openMap(w, open, lead, map.key);

    const shown = lines(page);
    expect(shown).toHaveLength(3);
    const [region, licence, style] = shown;
    expect(region?.textContent).toContain('Which region?');
    expect(region?.textContent).toContain('Sydney');
    const link = region?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`/task/${encodeURIComponent(cited.key)}`);
    expect(licence?.textContent).toContain('the licence decision of 12 August');
    expect(licence?.querySelector('a')).toBeNull();
    // An obvious call is marked as decided with its veto open; the others are not.
    expect((style as HTMLElement | undefined)?.dataset['vetoOpen']).toBe('true');
    expect(style?.textContent).toContain('decided, veto open');
    expect((region as HTMLElement | undefined)?.dataset['vetoOpen']).toBe('false');
    expect(region?.textContent).not.toContain('veto open');
  });

  it('WF-3 a pre-answer is never a line of Decisions so far', async () => {
    const cited = await decision('scope decision');
    const map = await mapWithPreAnswers(cited.id);
    const page = await openMap(w, open, lead, map.key);
    const decisions = page.find('[data-map-section="decisions"]');
    expect(decisions?.querySelectorAll('li')).toHaveLength(0);
    expect(decisions?.textContent).not.toContain('Which region?');
    expect(lines(page)).toHaveLength(3);
  });

  it('WF-3 a source the reader may not read shows as withheld, never by id or key', async () => {
    const cited = await decision('canary-withheld-decision');
    const map = await mapWithPreAnswers(cited.id);
    // A person granted this map alone: the cited record, on another map, is not theirs.
    const onMap = await w.member('on-map', ['read'], { kind: 'record', id: map.id });
    const page = await openMap(w, open, onMap, map.key);

    const [region] = lines(page);
    expect((region as HTMLElement | undefined)?.dataset['source']).toBe('withheld');
    expect(region?.textContent).toContain('withheld');
    expect(region?.querySelector('a')).toBeNull();
    const body = page.find(`${SECTION}`)?.innerHTML ?? '';
    for (const canary of [cited.id, cited.key, cited.map, 'canary-withheld-decision']) {
      expect(body).not.toContain(canary);
    }
  });

  it('WF-3 a map without pre-answers says so', async () => {
    const charted = await w.as(lead, { command: 'map.chart', title: 'no pre-answers' });
    const key = await keyOf(w, must(charted, 'chart').id);
    const page = await openMap(w, open, lead, key);
    expect(lines(page)).toHaveLength(0);
    expect(page.find(`${SECTION}`)?.textContent).toContain('No question was pre-answered');
  });
});
