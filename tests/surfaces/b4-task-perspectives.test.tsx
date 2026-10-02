// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH B4, the task page's second piece (TASK-PAGE.md S5, S6): the Team |
// Agent perspective tabs (TP-12) with the working controls arranged under them,
// none removed; the fact strip (DS-TASK-1) and the ten fields, every one now
// the record's (MP-4-2), so none sits inside the shared mock label; and the
// receipt drawn as the mockup's evidence box (DS-TASK-6).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';
import { EXECUTION, RECEIPT } from './b4-task-perspectives-fixture.ts';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TASK = {
  id: '33333333-3333-4333-8333-333333333333',
  key: 'TSK-42',
  title: 'A task seen from both sides',
  description: 'Pull the signed scope into one pack.',
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: { personId: 'p-1', name: 'Ada' },
  due: '2026-10-07T00:00:00.000Z',
  priority: null,
  completedAt: null,
  revision: 3,
  history: [],
  comments: [],
  alerts: [],
  clientAccess: true,
  proposals: [
    {
      lineageId: 'l-1',
      state: 'live',
      decisions: [],
      reservations: [],
      versions: [
        {
          versionId: 'v-2',
          version: 2,
          purpose: 'synthetic_comment',
          maximumMinor: 2_000,
          currency: 'AUD',
          payloadDigest: 'sha256:abc',
          payload: { change: 'a team-only comment' },
          supersededAt: null,
          runId: null,
          checks: [],
          evidence: null,
          gate: {
            id: 'g-2',
            state: 'pending',
            round: 1,
            expiresAt: '2099-01-01T00:00:00.000Z',
            expired: false,
            payloadDigest: 'sha256:abc',
          },
        },
      ],
    },
  ],
};

async function open() {
  let reads = 0;
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: [{ personId: 'p-1', name: 'Ada' }] }));
    }
    if (at.endsWith('/task/read')) {
      reads += 1;
      return Promise.resolve(json({ ok: true, task: TASK }));
    }
    if (at.endsWith('/task/execution')) return Promise.resolve(json(EXECUTION));
    if (at.endsWith('/task/receipt')) return Promise.resolve(json(RECEIPT));
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-42" />,
  );
  return { page, reads: () => reads };
}

const click = async (element: Element | null): Promise<void> => {
  await act(async () => {
    (element as HTMLElement | null)?.click();
    await pause();
  });
};

const inMock = (node: Element): boolean => node.closest('[data-provenance="mock"]') !== null;

/** The field labels inside a mock region, and those outside every one. */
const marked = (root: Element | null, selector: string): { mock: string[]; real: string[] } => {
  const all = [...(root?.querySelectorAll(selector) ?? [])];
  return {
    mock: all.filter((node) => inMock(node)).map((node) => node.textContent),
    real: all.filter((node) => !inMock(node)).map((node) => node.textContent),
  };
};

// The task page's sheet: a ticked box in the strip draws in the accent.
const TASK_SHEET = readFileSync(
  join(import.meta.dirname, '../../packages/ui/src/styles/5-task.css'),
  'utf8',
);

describe('B4 the Team and Agent perspectives', () => {
  it('opens on Team with both panes mounted, and the Agent tab counts the open gate', async () => {
    const { page } = await open();
    await tick();

    const tabs = page.all('[data-tabs="perspective"] [role="tab"]');
    expect(tabs.map((tab) => tab.firstChild?.textContent)).toStrictEqual(['Team', 'Agent']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toStrictEqual(['true', 'false']);
    expect(tabs[1]?.querySelector('.cbadge')?.textContent).toBe('1');
    const team = page.find('[data-tp-pane="team"]');
    const agent = page.find('[data-tp-pane="agent"]');
    expect(team?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    expect(agent?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    await page.unmount();
  });

  it('keeps every working control, Team holding the record and Agent the run and its gate', async () => {
    const { page } = await open();
    await tick();

    const team = page.find('[data-tp-pane="team"]');
    expect(team?.querySelector('[data-task-description]')?.textContent).toContain('signed scope');
    for (const hook of [
      '[data-lifecycle="start"]',
      '[data-lifecycle="complete"]',
      '[data-lifecycle="reopen"]',
      'select[aria-label="Assignee"]',
      'form#task-fields',
      '[data-comments="section"]',
    ]) {
      expect(team?.querySelector(hook), hook).not.toBeNull();
    }
    const agent = page.find('[data-tp-pane="agent"]');
    expect(agent?.querySelector('.tpg .tpg__main [data-run-progress]')).not.toBeNull();
    expect(agent?.querySelector('.tpg__main [data-proposals="section"] .gatebox')).not.toBeNull();
    expect(agent?.querySelector('.tpg__side [data-alerts]')).not.toBeNull();
    await page.unmount();
  });
});

describe('B4 switching perspective', () => {
  it('switches by attribute, and keeps the chosen side across a reread', async () => {
    const { page, reads } = await open();
    await tick();

    await click(page.find('[data-tabs="perspective"] [role="tab"]:nth-of-type(2)'));
    expect(page.find('[data-tp-pane="agent"]')?.closest('[hidden]')).toBeNull();
    expect(
      page.find('[data-tp-pane="team"]')?.closest('[role="tabpanel"]')?.hasAttribute('hidden'),
    ).toBe(true);

    const before = reads();
    await click(page.find('[data-refresh="task"]'));
    await tick();
    expect(reads()).toBe(before + 1);
    const selected = page.find('[data-tabs="perspective"] [aria-selected="true"]');
    expect(selected?.firstChild?.textContent).toBe('Agent');
    await page.unmount();
  });
});

describe('B4 the facts, the record’s and outside the mock label', () => {
  it('marks none of the strip or the ten fields as a sample: every one is read', async () => {
    const { page } = await open();
    await tick();

    const facts = page.find('.tpr__facts');
    const fields = marked(facts, '.tf__grid .tf__k');
    expect(fields.mock).toStrictEqual([]);
    expect(fields.real).toStrictEqual([
      'Assignee',
      'Client',
      'Due date',
      'Estimate',
      'Project',
      'Category',
      'Stage',
      'Status',
      'Page link',
      'Handling',
    ]);
    const strip = marked(facts, '.mstrip .mstrip__k');
    expect(strip.mock).toStrictEqual([]);
    expect(strip.real.map((key) => key.replace('derived', '').trim())).toStrictEqual([
      'Whose move',
      'Rank',
      'Ad hoc',
      'Client access',
    ]);
    // A field the read carries leaves the samples, and its mock label with it.
    expect(facts?.querySelectorAll('[data-provenance="mock"]').length).toBe(0);
    await page.unmount();
  });

  it('draws the strip read-only, ticks as pictures, a ticked one in the accent', async () => {
    const { page } = await open();
    await tick();

    const strip = page.find('.mstrip');
    expect(strip?.querySelector('button, input, select')).toBeNull();
    // A picture carries its state in its name and data-on; role img takes no aria-checked.
    expect(strip?.querySelectorAll('[aria-checked]').length).toBe(0);
    const on = (name: string): string | undefined =>
      strip?.querySelector<HTMLElement>(`[role="img"][aria-label="${name}"]`)?.dataset['on'];
    expect([on('Client access: yes'), on('Ad hoc: no')]).toEqual(['yes', 'no']);
    expect(TASK_SHEET).toMatch(
      /\.mstrip \.check\[data-on='yes'\]\s*\{[^}]*border-color:\s*var\(--accent\)/u,
    );
    await page.unmount();
  });
});

describe('B4 the receipt as the evidence box', () => {
  it('draws the receipt in the mockup box, its hooks and money line kept, no undo', async () => {
    const { page } = await open();
    await tick();

    const receipt = page.find('.sout[data-receipt-attempt="a-1"]');
    expect(receipt instanceof HTMLElement ? receipt.dataset['receiptDecision'] : null).toBe('d-1');
    expect(receipt?.querySelector('.sout__box .sout__row .tf__k')).not.toBeNull();
    expect(receipt?.textContent).toContain('version 1');
    expect(receipt?.querySelector('[data-money]')?.textContent).toBe(
      'held 20.00 · spent 15.00 · released 5.00',
    );
    expect(receipt?.querySelector('button')).toBeNull();
    await page.unmount();
  });
});
