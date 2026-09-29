// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-7-11 entry <row> on a fixture host (CS-7.37): the host draws the real
// sparkle for an entry point and, on its press, opens the real drawer with
// what the one ask seam made of it. The host stands in for each host page,
// whose own ticket places its sparkle and proves its entry (lane PI-FOLD-1);
// which panels open is the dock's (gesture law, MP-3-4), so the host only
// records the press's shift. The operations client is a recorder for the
// network only.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AskSparkle } from '../../packages/ui/src/surfaces/assistant/asker.tsx';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { entryFor, type EntryPoint } from '../../apps/web/src/assistant/entries.ts';
import { LOCAL_MODEL_WAIT } from '../../apps/web/src/assistant/subject.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';
import { CLIENT_ROWS } from './mp-7-11-entry-rows.ts';

afterEach(unmountAll);

const MERIDIAN = { id: '11111111-1111-4111-8111-111111111111', name: 'Meridian Physio' };
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function recorder(): { readonly client: OperationsClient; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      return Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      });
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

function Host(props: {
  readonly points: readonly EntryPoint[];
  readonly client: OperationsClient;
  readonly shifts: boolean[];
}): ReactElement {
  const [entry, setEntry] = useState<EntryPoint | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        {props.points.map((point) => (
          <AskSparkle
            key={`${point.row} ${point.widget.id}`}
            row={point.row}
            widget={point.widget.label}
            onAsk={(shift) => {
              // The host opens the drawer only for a press the seam makes an ask of.
              if (entryFor(point) === null) return;
              props.shifts.push(shift);
              setEntry({ ...point });
              setOpen(true);
            }}
          />
        ))}
      </main>
      {open ? (
        <AssistantView
          client={props.client}
          route="agency:settings"
          here="/settings"
          entry={entry}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

async function host(points: readonly EntryPoint[]) {
  const { client, sent } = recorder();
  const shifts: boolean[] = [];
  const page = track(await mount(<Host points={points} client={client} shifts={shifts} />));
  return { page, sent, shifts };
}

const clientPoint = (row: string, label = 'Leads this month'): EntryPoint => ({
  row,
  widget: { id: `${row}-widget`, label },
  client: MERIDIAN,
});

const input = (page: Awaited<ReturnType<typeof host>>['page']): HTMLInputElement => {
  const found = page.find('[data-assistant="input"]');
  if (!(found instanceof HTMLInputElement)) throw new Error('no input in the drawer');
  return found;
};

describe('MP-7-11 entry <row> on a fixture host, a client row', () => {
  it.each(CLIENT_ROWS)(
    'MP-7-11 entry %s: opens the drawer on this client with the widget cited, nothing sent',
    async (row, about) => {
      const { page, sent, shifts } = await host([clientPoint(row)]);
      expect(page.find('[data-assistant="panel"]')).toBeNull();
      await page.click(`[data-ask="${row}"]`);
      await settle();
      const citation = page.find('[data-assistant="citation"]');
      expect(citation?.textContent).toBe('Asked from Leads this month');
      expect(citation?.getAttribute('data-ask-row')).toBe(row);
      expect(input(page).value).toMatch(about);
      expect(input(page).value).toContain('Meridian Physio');
      expect(input(page).getAttribute('aria-label')).toBe('Ask the agent about Meridian Physio');
      // A client's material waits on a local model: the drafted question stays
      // a draft, and neither Enter nor Send carries it anywhere.
      expect(page.find('[data-assistant="local-model"]')?.textContent).toBe(LOCAL_MODEL_WAIT);
      await press(page, '[data-assistant="input"]', 'Enter');
      await page.click('[data-assistant="send"]');
      await settle();
      expect(sent).toStrictEqual([]);
      expect(shifts).toStrictEqual([false]);
    },
  );
});

describe('MP-7-11 entry AG-K7 on a fixture host', () => {
  const agency: EntryPoint = {
    row: 'AG-K7',
    widget: { id: 'attention-overdue', label: 'Overdue work' },
    client: null,
    question: 'What is overdue across the agency?',
  };

  it('the row’s question prefilled, the widget cited, the page the subject; sent only on Send', async () => {
    const { page, sent } = await host([agency]);
    await page.click('[data-ask="AG-K7"]');
    await settle();
    expect(page.find('[data-assistant="citation"]')?.getAttribute('data-ask-row')).toBe('AG-K7');
    expect(input(page).value).toBe('What is overdue across the agency?');
    expect(input(page).getAttribute('aria-label')).toBe('Ask the agent about Settings');
    expect(page.find('[data-assistant="local-model"]')).toBeNull();
    expect(sent).toStrictEqual([]);
    await page.click('[data-assistant="send"]');
    await settle();
    expect(sent).toStrictEqual([
      {
        name: 'conversation.start',
        body: {
          body: 'What is overdue across the agency?',
          title: 'Chat 2',
          subject: 'Settings',
          scope: null,
        },
      },
    ]);
  });

  it('handed a client, it opens nothing: an agency-wide page never talks about one client', async () => {
    const { page, shifts } = await host([{ ...agency, client: MERIDIAN }]);
    await page.click('[data-ask="AG-K7"]');
    await settle();
    expect(page.find('[data-assistant="panel"]')).toBeNull();
    expect(shifts).toStrictEqual([]);
  });
});

describe('MP-7-11 entry on a fixture host, between entries', () => {
  it('a second sparkle replaces the first citation and its draft', async () => {
    const { page } = await host([
      clientPoint('CL-M03'),
      clientPoint('RV-M03', 'Attributed revenue, March'),
    ]);
    await page.click('[data-ask="CL-M03"]');
    await settle();
    await page.click('[data-ask="RV-M03"]');
    await settle();
    const citations = page.all('[data-assistant="citation"]');
    expect(citations).toHaveLength(1);
    expect(citations[0]?.getAttribute('data-ask-row')).toBe('RV-M03');
    expect(citations[0]?.textContent).toBe('Asked from Attributed revenue, March');
    expect(input(page).value).toMatch(/attributed revenue/iu);
  });

  it('a client row with no client in scope opens nothing', async () => {
    const { page, sent } = await host([{ ...clientPoint('EM-M03'), client: null }]);
    await page.click('[data-ask="EM-M03"]');
    await settle();
    expect(page.find('[data-assistant="panel"]')).toBeNull();
    expect(sent).toStrictEqual([]);
  });
});
