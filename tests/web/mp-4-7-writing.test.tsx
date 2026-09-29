// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-7: the description and the agent brief (CS-4.23, CS-4.24, DP-34,
// DP-35, TT-01, TA-10, TA-11, R60).
//
// Two voices under their tabs: the description is the Team side's, the brief
// the Agent side's. On the page both are read (TT-06: the page reads, the
// dock task panel edits); the panel's two fields write each one through
// `task.update` under `task:write`. The brief is always present, empty
// included. What was asked for is read from the brief's own headings. The
// description is sans everywhere; mono is kept for the brief's markdown field
// alone (R60).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefFacts } from '../../apps/web/src/screens/task/brief-facts.ts';
import { BriefField, DescriptionField } from '../../apps/web/src/screens/task/Writing.tsx';
import { found, TASK_ID } from './task-page-stub.tsx';
import { mount, page, unmountAll } from './perspective-support.tsx';
import { BRIEF, field, textOf } from './writing-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

afterEach(async () => {
  await unmountAll();
});

const pane = (view: Mounted, side: 'team' | 'agent'): Element | null =>
  view.find(`#perspective-panel-${side}`);

const facts = (view: Mounted): string[] =>
  view.all('[data-writing="asked-for"] .sout__row').map((row) => row.textContent ?? '');

describe('MP-4-7 two voices under their tabs', () => {
  it('the description reads on the Team side and the brief on the Agent side, each once', async () => {
    const view = await page(
      'Proj-Verity-Pacing',
      found({ description: 'Fix the pacing on Verity.', agentBrief: BRIEF }),
    );
    expect(
      pane(view, 'team')?.querySelector('[data-writing="description"]')?.textContent,
    ).toContain('Fix the pacing on Verity.');
    expect(pane(view, 'agent')?.querySelector('[data-writing="description"]')).toBeNull();
    expect(pane(view, 'agent')?.querySelector('[data-writing="brief"]')?.textContent).toContain(
      'Hold the daily spend inside the monthly budget.',
    );
    expect(pane(view, 'team')?.querySelector('[data-writing="brief"]')).toBeNull();
  });

  it('the empty description says so in words', async () => {
    const view = await page('Proj-Verity-Pacing', found({ description: null, agentBrief: null }));
    expect(view.find('[data-writing="description"]')?.textContent).toContain(
      'No description on this one yet.',
    );
  });

  it('draws the brief as markdown elements, never as markup the brief wrote', async () => {
    const hostile = '# Head\n<img src=x onerror="alert(1)">\n- one\n- **two**';
    const view = await page('Proj-Verity-Pacing', found({ agentBrief: hostile }));
    const brief = view.find('[data-writing="brief"] .md');
    expect(brief?.querySelector('img')).toBeNull();
    expect(brief?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(brief?.querySelectorAll('li').length).toBe(2);
    expect(brief?.querySelector('li strong')?.textContent).toBe('two');
  });
});

describe('MP-4-7 the brief is always present', () => {
  it('an empty brief keeps its section on the Agent side, saying none has been written', async () => {
    for (const agentBrief of [null, '', '   \n ']) {
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      const view = await page('Proj-Verity-Pacing', found({ agentBrief }));
      expect(pane(view, 'agent')?.querySelector('[data-writing="brief"]')?.textContent).toContain(
        'No brief has been written for this task yet.',
      );
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      await unmountAll();
    }
  });

  it('the panel’s brief field is drawn empty with its placeholder', async () => {
    const { client, onSaved } = field();
    const view = await mount(
      <BriefField client={client} recordId={TASK_ID} revision={4} value={null} onSaved={onSaved} />,
    );
    const area = view.find('textarea[data-writing="brief"]');
    expect(area?.getAttribute('placeholder')).toBe(
      'The pre-prompt an agent boots on — write it here.',
    );
    expect(textOf(view, 'textarea[data-writing="brief"]')).toBe('');
  });
});

describe('MP-4-7 brief facts read from headings', () => {
  it('reads the named headings, bold leads and their lines, in the brief’s order', () => {
    expect(briefFacts(BRIEF)).toStrictEqual([
      { key: 'Objective', value: 'Hold the daily spend inside the monthly budget.' },
      {
        key: 'Definition of done',
        value: 'Spend tracks the line for seven days.\nThe report says so.',
      },
      { key: 'Escalation', value: 'ask Ada before touching bids.' },
    ]);
  });

  it('guesses nothing: prose with no such heading, or a heading with nothing under it, gives none', () => {
    expect(briefFacts('Hold the spend inside the budget.\nThat is the goal.')).toStrictEqual([]);
    expect(briefFacts('## Constraints\n\n## Goal\n')).toStrictEqual([]);
    expect(briefFacts(null)).toStrictEqual([]);
  });

  it('knows the synonyms and no others', () => {
    expect(
      briefFacts('## Guardrails\nNo spend.\n## Stop if\nthe budget moves.').map((f) => f.key),
    ).toStrictEqual(['Constraints', 'Escalation']);
    expect(briefFacts('## Goalposts\nmoved.\n## Rulebook\nnone.').map((f) => f.key)).toStrictEqual(
      [],
    );
  });

  it('the page draws them under the brief, and none at all when it names none', async () => {
    const view = await page('Proj-Verity-Pacing', found({ agentBrief: BRIEF }));
    expect(facts(view)).toStrictEqual([
      'ObjectiveHold the daily spend inside the monthly budget.',
      'Definition of doneSpend tracks the line for seven days.\nThe report says so.',
      'Escalationask Ada before touching bids.',
    ]);
    await unmountAll();
    const none = await page('Proj-Verity-Pacing', found({ agentBrief: 'Just do it.' }));
    expect(none.find('[data-writing="asked-for"]')).toBeNull();
  });
});

describe('MP-4-7 the description is sans everywhere; mono only on the Agent MD field (R60)', () => {
  const css = readFileSync(
    join(import.meta.dirname, '../../packages/ui/src/styles/5-task.css'),
    'utf8',
  );
  const rule = (selector: string): string =>
    new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ??
    '';

  it('the description field and prose are sans; the brief field alone is mono', async () => {
    const { client, onSaved } = field();
    const view = await mount(
      <>
        <DescriptionField
          client={client}
          recordId={TASK_ID}
          revision={4}
          value="d"
          onSaved={onSaved}
        />
        <BriefField client={client} recordId={TASK_ID} revision={4} value="b" onSaved={onSaved} />
      </>,
    );
    expect(view.find('textarea[data-writing="description"]')?.className).toBe('tf__ta');
    expect(view.find('textarea[data-writing="brief"]')?.className).toBe('tf__ta tf__ta--md');
    expect(rule('.tf__ta')).toContain('font-family: var(--font-sans)');
    expect(rule('.tf__ta--md')).toContain('font-family: var(--font-mono)');
    expect(rule('.tt__prose')).toContain('font-family: var(--font-sans)');
  });

  it('the page draws the description and the rendered brief as sans prose', async () => {
    const view = await page('Proj-Verity-Pacing', found({ description: 'x', agentBrief: 'y' }));
    expect(view.find('[data-writing="description"] .tt__prose')).not.toBeNull();
    expect(view.find('[data-writing="brief"] .md.tt__prose')).not.toBeNull();
  });
});

describe('MP-4-7 visual match', () => {
  it.todo(
    'matches the mockup’s dock task panel and task page at 1480, 900 and 390, light and dark (MP-1-7 harness)',
  );
});
