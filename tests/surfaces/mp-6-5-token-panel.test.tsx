// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-5, the token panel on the Agent pane (DA-08, DA-09, DS-TASK-9) over
// `task.read`'s ledger and proposals, shaped exactly as the read returns them
// (`tests/api/mp-6-5-ledger.test.ts` proves the read against Postgres). The
// figures are the envelope's own; the per-run rows are the reservations that
// name it. The panel writes nothing: the skill chips and the data-source link
// are doors.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, exactly as it was first written red */

import { afterEach, describe, expect, it } from 'vitest';
import type { RunLineage, TaskLedger } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type Envelope = TaskLedger['envelopes'][number];
type Reservation = RunLineage['reservations'][number];

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: 'env-1',
    state: 'open',
    maximumMinor: 5_000,
    heldMinor: 2_500,
    actualMinor: 1_200,
    currency: 'AUD',
    openedAt: '2026-09-29T01:00:00.000Z',
    closedAt: null,
    openedBy: { versionId: 'v-1' },
    cap: { key: 'agent_work', limitMinor: 100_000, currency: 'AUD' },
    ...overrides,
  };
}

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'res-1',
    envelopeId: 'env-1',
    runId: 'run-1',
    state: 'settled',
    heldMinor: 0,
    actualMinor: 1_200,
    classifiedCause: null,
    lease: null,
    attempt: null,
    ...overrides,
  };
}

const EVIDENCE = {
  digest: 'e1',
  body: {
    skills: [{ name: 'Reply drafting' }, 'Tone check'],
    dataSource: { label: 'The client’s inbox thread', href: 'https://mail.example.test/t/42' },
  },
};

/** One task, one envelope, two runs against it: one settled, one still holding. */
function world(over: { envelope?: Partial<Envelope>; runs?: readonly Reservation[] } = {}) {
  const runs = over.runs ?? [
    reservation(),
    reservation({
      id: 'res-2',
      runId: 'run-2',
      state: 'held',
      heldMinor: 2_500,
      actualMinor: null,
      lease: { state: 'live' },
      attempt: { state: 'dispatched' },
    }),
  ];
  return {
    ledger: { envelopes: [envelope(over.envelope)] },
    lineages: [
      lineage({
        versions: [
          version({ versionId: 'v-2', version: 2, runId: 'run-2', evidence: EVIDENCE }),
          version({ versionId: 'v-1', version: 1, runId: 'run-1', evidence: EVIDENCE }),
        ],
        reservations: runs,
      }),
    ],
  };
}

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

// eslint-disable-next-line max-lines-per-function -- one panel, each checklist line of it
describe('MP-6-5 token panel', () => {
  it('MP-6-5 allowance composition: the allowance, the approval that opened it and the cap it draws on', async () => {
    const page = await pane(world());
    const panel = page.find('[data-agent="tokens"]');
    expect(panel?.getAttribute('data-tokens')).toBe('tracked');
    expect(text(page.find('[data-tokens="head"]'))).toBe('AUD 12.00 of AUD 50.00');
    expect(text(page.find('[data-tokens="allowance"]'))).toContain('AUD 50.00');
    expect(text(page.find('[data-tokens="opened-by"]'))).toContain('version 1');
    const cap = page.find('[data-tokens="cap"]');
    expect(text(cap)).toContain('agent_work');
    expect(text(cap)).toContain('AUD 1000.00');
    expect(page.all('[data-tokens="skill"]').map((chip) => chip.textContent)).toStrictEqual([
      'Reply drafting',
      'Tone check',
    ]);
  });

  it('MP-6-5 allowance composition: no envelope says so in words, and an agent is shown no panel', async () => {
    const none = await pane({ ledger: { envelopes: [] }, lineages: [lineage()] });
    expect(none.find('[data-agent="tokens"]')?.getAttribute('data-tokens')).toBe('none');
    expect(text(none.find('[data-agent="tokens"]'))).toContain('No allowance on this task yet');
    expect(none.find('[data-tokens="bar"]')).toBeNull();
    const agent = await pane({ ...world(), ledger: null });
    expect(agent.find('[data-agent="tokens"]')).toBeNull();
  });

  it('MP-6-5 over-allowance danger: spent under the allowance draws no danger', async () => {
    const page = await pane(world());
    expect(text(page.find('[data-tokens="spent"]'))).toContain('AUD 12.00');
    expect(page.find('[data-tokens="bar"] .tt__fill')?.getAttribute('style')).toContain(
      'width: 24%',
    );
    expect(page.find('[data-tokens="bar"] .tt__fill.is-over')).toBeNull();
    expect(page.find('[data-tokens="over"]')).toBeNull();
  });

  it('MP-6-5 over-allowance danger: spent past the allowance is drawn in danger with the amount over', async () => {
    const page = await pane(
      world({
        envelope: { heldMinor: 0, actualMinor: 6_100 },
        runs: [
          reservation({ actualMinor: 2_600 }),
          reservation({ id: 'res-2', runId: 'run-2', actualMinor: 3_500 }),
        ],
      }),
    );
    expect(text(page.find('[data-tokens="head"]'))).toBe('AUD 61.00 of AUD 50.00');
    const over = page.find('[data-tokens="over"]');
    expect(over?.classList.contains('brn__over')).toBe(true);
    expect(text(over)).toBe('AUD 11.00 over');
    const fill = page.find('[data-tokens="bar"] .tt__fill');
    expect(fill?.classList.contains('is-over')).toBe(true);
    expect(fill?.getAttribute('style')).toContain('width: 100%');
  });

  it('MP-6-5 per-run rows match the ledger: one row per reservation on the envelope, adding up to it', async () => {
    const page = await pane(world());
    const rows = page.all('[data-token-run]');
    expect(rows.map((row) => row.getAttribute('data-token-run'))).toStrictEqual(['res-1', 'res-2']);
    expect(rows.map((row) => text(row.querySelector('.tokrun__model')))).toStrictEqual([
      'run-1',
      'run-2',
    ]);
    expect(rows.map((row) => row.getAttribute('data-run-state'))).toStrictEqual([
      'settled',
      'held',
    ]);
    expect(text(rows[0]?.querySelector('[data-run="spent"]'))).toBe('AUD 12.00');
    expect(text(rows[1]?.querySelector('[data-run="held"]'))).toBe('AUD 25.00');
    expect(text(rows[1]?.querySelector('[data-run="spent"]'))).toBe('not settled');
    expect(text(page.find('[data-tokens="held"]'))).toContain('AUD 25.00');
    expect(text(page.find('[data-tokens="runs"]'))).toBe('2 runs');
  });

  it('MP-6-5 per-run rows match the ledger: a reservation on another envelope is not a row of this one', async () => {
    const page = await pane(
      world({ runs: [reservation(), reservation({ id: 'res-9', envelopeId: 'env-old' })] }),
    );
    expect(
      page.all('[data-token-run]').map((row) => row.getAttribute('data-token-run')),
    ).toStrictEqual(['res-1']);
  });

  it('MP-6-5 per-run rows match the ledger: an allowance with no runs is not a zero', async () => {
    const page = await pane(world({ envelope: { heldMinor: 0, actualMinor: 0 }, runs: [] }));
    expect(page.all('[data-token-run]')).toHaveLength(0);
    expect(text(page.find('[data-agent="tokens"]'))).toContain('Nothing has run against');
  });

  it('MP-6-5 skill chip unavailable with reason', async () => {
    const page = await pane(world());
    const chips = page.all('[data-tokens="skill"]');
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.hasAttribute('disabled')).toBe(true);
      expect(chip.getAttribute('aria-describedby')).toBe(
        page.find('[data-tokens="skill-reason"]')?.id,
      );
    }
    expect(text(page.find('[data-tokens="skill-reason"]'))).toContain('Docs panel');
    // Each run row names the skills its own version used, drawn the same way.
    const rowChips = page.all('[data-token-run="res-1"] [data-tokens="skill"]');
    expect(rowChips.map((chip) => chip.hasAttribute('disabled'))).toStrictEqual([true, true]);
  });

  it('MP-6-5 skill chip unavailable with reason: hostile skill entries are text, never markup or links', async () => {
    const hostile = {
      digest: 'e2',
      body: {
        skills: ['<img src=x onerror=alert(1)>', 7, null, { name: 42 }, { name: 'Real one' }],
      },
    };
    const page = await pane({
      ledger: { envelopes: [envelope()] },
      lineages: [
        lineage({ versions: [version({ evidence: hostile })], reservations: [reservation()] }),
      ],
    });
    expect(page.all('[data-tokens="skill"]').map((chip) => chip.textContent)).toStrictEqual([
      '<img src=x onerror=alert(1)>',
      'Real one',
    ]);
    expect(page.find('[data-agent="tokens"] img')).toBeNull();
    expect(page.find('[data-agent="tokens"] a[href]')).toBeNull();
  });

  it('MP-6-5 data-source link goes to its source', async () => {
    const page = await pane(world());
    const link = page.find('[data-tokens="source"]');
    expect(link?.tagName).toBe('A');
    expect(link?.getAttribute('href')).toBe('https://mail.example.test/t/42');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(text(link)).toBe('The client’s inbox thread');
  });

  it('MP-6-5 data-source link: an address that is not http or https is drawn as text', async () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<b>x</b>',
      '//evil.example.test/x',
      'vbscript:msgbox(1)',
      '',
    ]) {
      const evidence = { digest: 'e3', body: { dataSource: { label: 'Source', href } } };
      // eslint-disable-next-line no-await-in-loop -- one pane at a time
      const page = await pane({
        ledger: { envelopes: [envelope()] },
        lineages: [lineage({ versions: [version({ evidence })], reservations: [reservation()] })],
      });
      const source = page.find('[data-tokens="source"]');
      expect(source?.tagName).toBe('SPAN');
      expect(source?.hasAttribute('href')).toBe(false);
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await unmountAll();
    }
  });

  it.skip('MP-6-5 stop states (LEANS-ON SL11 AW-05: the stop, the top-up request, stops counted to three and the consolidated decision live in 0034_budget_wait and 0035_budget_answers, unmerged)', () => {
    // Written when AW-05's states reach this branch: the panel shows the stop
    // and the top-up request, counts the stops against three, and after the
    // third shows the one consolidated decision; answering them is C54's.
  });
});
