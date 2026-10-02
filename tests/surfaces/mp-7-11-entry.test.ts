// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11, the one ask seam by register row (CS-7.37): from an entry point's
// row, widget and client, the scope, the subject, the drafted question and the
// cited widget. The rows are written out here from the ticket, as an oracle
// independent of the register the code keeps. Each entry drawn on a host and
// opened in the drawer is `mp-7-11-entry-host.test.tsx`.

import { describe, expect, it } from 'vitest';
import { ask, initial } from '../../apps/web/src/assistant/chats.ts';
import { ENTRY_ROWS, entryFor, type EntryPoint } from '../../apps/web/src/assistant/entries.ts';
import { LOCAL_MODEL_WAIT, modelOffer, subjectFor } from '../../apps/web/src/assistant/subject.ts';
import { CLIENT_ROWS } from './mp-7-11-entry-rows.ts';

const MERIDIAN = { id: '11111111-1111-4111-8111-111111111111', name: 'Meridian Physio' };
const CATALOGUE = [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }];

const point = (overrides: Partial<EntryPoint> = {}): EntryPoint => ({
  row: 'CL-M03',
  widget: { id: 'clients-row-meridian', label: 'Leads this month' },
  client: MERIDIAN,
  ...overrides,
});

describe('MP-7-11 entry register', () => {
  it('holds exactly the ticket’s entry rows', () => {
    expect(Object.keys(ENTRY_ROWS).toSorted()).toStrictEqual(
      ['AG-K7', ...CLIENT_ROWS.map(([row]) => row)].toSorted(),
    );
  });
});

describe('MP-7-11 entry <row>, a client row', () => {
  it.each(CLIENT_ROWS)(
    'MP-7-11 entry %s: scoped to this client, the widget cited, the question drafted',
    (row, about) => {
      const entry = entryFor(point({ row }));
      expect(entry).not.toBeNull();
      if (entry === null) return;
      expect(entry.row).toBe(row);
      expect(entry.widget).toStrictEqual({ id: 'clients-row-meridian', label: 'Leads this month' });
      expect(entry.scope).toStrictEqual({ client: MERIDIAN, task: null });
      expect(entry.question).toMatch(about);
      expect(entry.question).toContain('Leads this month');
      expect(entry.question).toContain('Meridian Physio');
      // The subject the drawer then shows, and what it may offer for it.
      const subject = subjectFor({ route: 'agency:projects-board', ...entry.scope });
      expect(subject).toMatchObject({ kind: 'client', label: 'Meridian Physio' });
      expect(subject.clientId).toBe(MERIDIAN.id);
      expect(modelOffer(subject, CATALOGUE, null)).toStrictEqual({
        models: [],
        waiting: LOCAL_MODEL_WAIT,
      });
      // Through the seam: a fresh tab, the citation and the draft, nothing else.
      const opened = ask(initial(), entry);
      expect(opened.citation).toStrictEqual({
        row,
        id: 'clients-row-meridian',
        label: 'Leads this month',
      });
      expect(opened.draft).toBe(entry.question);
    },
  );

  it('a row’s own question (its data-ask) is drafted in place of the built one', () => {
    const entry = entryFor(point({ question: '  Why did leads drop in March?  ' }));
    expect(entry?.question).toBe('Why did leads drop in March?');
  });

  it('a client row with no client in scope opens nothing', () => {
    for (const [row] of CLIENT_ROWS) {
      expect(entryFor(point({ row, client: null }))).toBeNull();
    }
    expect(entryFor(point({ client: { id: MERIDIAN.id, name: '   ' } }))).toBeNull();
    expect(entryFor(point({ client: { id: '', name: 'Meridian Physio' } }))).toBeNull();
  });
});

describe('MP-7-11 entry AG-K7', () => {
  const agency = point({
    row: 'AG-K7',
    widget: { id: 'attention-overdue', label: 'Overdue work, attention rows' },
    client: null,
    question: 'What is overdue across the agency?',
  });

  it('the row’s question prefilled and the widget cited, about the page and no client', () => {
    const entry = entryFor(agency);
    expect(entry).toStrictEqual({
      row: 'AG-K7',
      widget: { id: 'attention-overdue', label: 'Overdue work, attention rows' },
      question: 'What is overdue across the agency?',
      scope: { client: null, task: null },
    });
    const subject = subjectFor({ route: 'agency:settings', client: null, task: null });
    expect(subject.kind).toBe('page');
  });

  it('an agency-wide page never talks about one client: a client handed to it opens nothing', () => {
    expect(entryFor({ ...agency, client: MERIDIAN })).toBeNull();
  });

  it('it has no question of its own to build, so a row without one opens nothing', () => {
    const { question: _question, ...bare } = agency;
    expect(entryFor(bare)).toBeNull();
    expect(entryFor({ ...agency, question: ' \t ' })).toBeNull();
  });
});

describe('MP-7-11 entry refusals', () => {
  it('a row the register does not hold opens nothing, whatever its spelling', () => {
    for (const row of ['AG-K8', 'cl-m03', ' CL-M03', 'CL-M03 ', 'CL-M03​', '', 'toString']) {
      expect(entryFor(point({ row }))).toBeNull();
    }
  });

  it('a widget with no id or no words opens nothing', () => {
    expect(entryFor(point({ widget: { id: '', label: 'Leads this month' } }))).toBeNull();
    expect(entryFor(point({ widget: { id: 'w', label: '  ' } }))).toBeNull();
  });
});
