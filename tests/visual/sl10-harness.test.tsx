// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10's surfaces on MP-1-7's width-and-theme harness: the harness captures
// line of MP-7-3, MP-7-10, MP-8-4, C4, C2 and MP-9-1, each surface drawn in
// the pinned headless shell at 1480, 900 and 390, light and dark, with made-up
// props (`kit-captures.ts`). Each picture must exist as a PNG as wide as its
// width, scroll no way sideways, and draw differently in dark than in light.
// The comparison with the mockup's dock states (`p-notifs`, `p-team`) is the
// visual-match line, held with the mockup's states (ruling (b)9).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BarList,
  DataTable,
  DetailRow,
  FreshnessMarker,
  InboxPage,
  Layer,
  Ledger,
  Legend,
  NotificationsPanel,
  PageMeter,
  SectionHead,
  Stat,
  StatRow,
  TeamPanel,
  type LedgerDay,
} from '../../packages/ui/src/index.ts';
import { TaskPresence } from '../../apps/web/src/views/presence.tsx';
import { props as inboxProps } from '../surfaces/inbox-fixture.tsx';
import { THREADS, props as teamProps } from '../surfaces/team-fixture.tsx';
import { comparePng } from './compare.ts';
import { captureSurfaces, sheets, WIDTHS, type Surface } from './kit-captures.ts';
import { readPacket } from './packet.ts';
import { report, type PageShot } from './report.ts';

const DAYS: readonly LedgerDay[] = [
  {
    day: '2026-09-29',
    events: [
      {
        id: 'e3',
        at: '2026-09-29T02:10:00Z',
        actorName: 'Ari',
        operation: 'task.complete',
        task: { key: 'T-2', title: 'Send the quote' },
      },
      {
        id: 'e2',
        at: '2026-09-28T23:05:00Z',
        actorName: 'Bo',
        operation: 'task.assign',
        task: { key: 'T-1', title: null },
      },
    ],
  },
  {
    day: '2026-09-28',
    events: [
      {
        id: 'e1',
        at: '2026-09-28T01:15:00Z',
        actorName: 'Ari',
        operation: 'task.create',
        task: { key: 'T-1', title: 'Book the shoot' },
      },
    ],
  },
];

const none = (): void => {};
const href = (key: string): string => `/task/${key}`;
const ROWS = [
  { id: 'r1', name: 'Acme', hours: 12.5, share: 0.42 },
  { id: 'r2', name: 'Birch', hours: 7, share: 0.23 },
  { id: 'r3', name: 'Cedar', hours: 10.25, share: 0.35 },
];

/** Each ticket's surfaces, as its capture names them. */
const SURFACES: Readonly<Record<string, readonly [string, ReactElement][]>> = {
  'MP-7-3': [
    ['notifications-panel', <NotificationsPanel {...inboxProps()} />],
    ['inbox-page', <InboxPage {...inboxProps()} />],
  ],
  'MP-7-10': [['team-panel', <TeamPanel {...teamProps({ threads: THREADS })} />]],
  'MP-8-4': [
    [
      'work-log',
      <Ledger
        days={DAYS}
        earlier
        loading={false}
        today="2026-09-29"
        timeZone="Australia/Brisbane"
        taskHref={href}
        onOpenTask={none}
        onLoadEarlier={none}
      />,
    ],
  ],
  C4: [
    [
      'freshness-marker',
      <div>
        <FreshnessMarker freshness={{ state: 'live', age: 'just now' }} />
        <FreshnessMarker freshness={{ state: 'catching-up', lastRead: '10:42' }} />
        <FreshnessMarker freshness={{ state: 'offline', lastRead: '10:40' }} />
        <FreshnessMarker
          freshness={{
            state: 'source-behind',
            source: 'Xero',
            lastGood: '09:15',
            href: '/connections/',
          }}
        />
        <FreshnessMarker freshness={{ state: 'frozen', at: 'Mon 28 Sep, 5:00 pm' }} />
      </div>,
    ],
  ],
  C2: [
    [
      'task-presence',
      <TaskPresence
        seen={[
          { personId: 'p-remy', name: 'Remy Hale', state: 'viewing', field: null },
          { personId: 'p-cath', name: 'Cath Lea', state: 'changing', field: 'due' },
        ]}
      />,
    ],
  ],
  'MP-9-1': [
    [
      'page-kit',
      <div>
        <SectionHead index="01" title="This week" />
        <StatRow columns={3}>
          <Stat
            label="Hours logged"
            value={29.75}
            suffix="h"
            delta={{ value: 4, period: 'last week' }}
          />
          <Stat label="Tasks done" value={12} of={18} track />
          <Stat label="Owed" value={3} />
        </StatRow>
        <DataTable
          label="Hours by client"
          rows={ROWS}
          rowKey={(row) => row.id}
          columns={[
            { id: 'name', label: 'Client', value: (row) => row.name },
            { id: 'hours', label: 'Hours', value: (row) => row.hours, numeric: true },
          ]}
        />
        <BarList
          label="Share of hours"
          bars={ROWS.map((row) => ({ id: row.id, label: row.name, value: row.hours }))}
        />
        <PageMeter label="Budget used" value={62} max={100} target={80} tone="warn" />
        <Legend
          label="Kinds"
          items={[
            { id: 'a', label: 'Billable', tone: 'accent' },
            { id: 'b', label: 'Internal', tone: 'muted' },
          ]}
        />
        <Layer order={1} title="Open work" count={2}>
          <DetailRow
            title="Book the shoot"
            detail="Due Friday"
            items={['Call the studio', 'Send the brief']}
          />
        </Layer>
        <Layer order={3} title="Closed" count={5} />
      </div>,
    ],
  ],
};

let out: string;
let shots: PageShot[];
beforeAll(async () => {
  // Drawn under every sheet the app loads, the surfaces' own included.
  const loaded = sheets().map((sheet) => sheet.split('/').at(-1));
  for (const own of ['8-notifications.css', '9-ledger.css', '10-team.css', '7-page-kit.css'])
    expect(loaded).toContain(own);
  out = mkdtempSync(join(tmpdir(), 'sl10-harness-'));
  const all: Surface[] = Object.values(SURFACES).flatMap((list) =>
    list.map(([id, element]) => ({ id, markup: renderToStaticMarkup(element) })),
  );
  shots = await captureSurfaces(all, join(out, 'captures'));
}, 600_000);
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/** The ticket's surfaces on the harness: every picture there, none sideways, dark drawn dark. */
function captured(ticket: string): void {
  const pages = (SURFACES[ticket] ?? []).map(([id]) => id);
  const packet = readPacket();
  const all = report({ ...packet, widths: [...WIDTHS] }, pages, shots);
  expect(all.failed, all.lines.join('\n')).toBe(0);
  const file = (page: string, width: number, theme: string): Buffer =>
    readFileSync(join(out, 'captures', `${page}@${width}-${theme}.page.png`));
  for (const page of pages)
    for (const width of WIDTHS) {
      for (const theme of ['light', 'dark'])
        expect(all.lines).toContain(
          `ok ${page}@${width}-${theme}: ${page}@${width}-${theme}.page.png; no sideways scroll`,
        );
      const name = `${page}@${width}`;
      const same = comparePng(name, file(page, width, 'light'), file(page, width, 'dark'));
      expect(same.pass, `${name} dark draws the same as light`).toBe(false);
    }
}

describe('SL10 surfaces on the width-and-theme harness (MP-1-7)', () => {
  it('MP-7-3 harness captures: the Notifications panel and /inbox/ in light and dark at 1480, 900 and 390', () => {
    captured('MP-7-3');
  });
  it('MP-7-10 harness captures: the Team panel in light and dark at 1480, 900 and 390', () => {
    captured('MP-7-10');
  });
  it('MP-8-4 harness captures: the work log in light and dark at 1480, 900 and 390', () => {
    captured('MP-8-4');
  });
  it('C4 harness captures: the freshness marker in each state, light and dark, at 1480, 900 and 390', () => {
    captured('C4');
  });
  it('C2 harness captures: who else is on the task, light and dark, at 1480, 900 and 390', () => {
    captured('C2');
  });
  it("MP-9-1 harness captures: the page kit's parts in light and dark at 1480, 900 and 390", () => {
    captured('MP-9-1');
  });
});
