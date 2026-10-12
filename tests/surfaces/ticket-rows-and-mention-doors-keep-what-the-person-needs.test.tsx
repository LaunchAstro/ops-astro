// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { TicketsView } from '../../apps/web/src/screens/map/Tickets.tsx';
import { InboxScreen } from '../../apps/web/src/screens/Inbox.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { WAYFINDER_READS } from '../visual/made-up-wayfinder.ts';
import { mount } from './mount.tsx';
import { until } from '../web/screen-until.tsx';

/* eslint-disable require-unicode-regexp, max-lines-per-function, require-await -- Sol's proofs, kept as written */

// Sol's proof on #1378 (round 1), retitled by what it proves; its body is Sol's.
it('a ticket row offers a claim action', async () => {
  const map = WAYFINDER_READS['map.view'].map;
  const sent: string[] = [];
  const page = await mount(
    <TicketsView
      map={map}
      filters={{ type: '', text: '' }}
      locked={() => false}
      send={(command) => {
        sent.push(command);
      }}
    />,
  );
  const row = page.find(`[data-ticket-row="${map.tickets[1]?.id ?? ''}"]`);
  const claim = [...(row?.querySelectorAll('button') ?? [])].find((button) =>
    /claim/i.test(button.textContent ?? ''),
  );
  expect(claim, 'CS-15.7 requires a claim action on ticket rows').toBeDefined();
  await act(() => claim?.click());
  expect(sent).toContain('task.claim');
});

// Sol's proof on #1378 (round 1), retitled by what it proves; its body is Sol's.
it('a ticket row shows the tickets it blocks', async () => {
  const source = WAYFINDER_READS['map.view'].map;
  const first = source.tickets[0];
  const second = source.tickets[1];
  if (first === undefined || second === undefined) throw new Error('two tickets required');
  const map = {
    ...source,
    tickets: [
      { ...first, key: 'T-901', title: 'Upstream', blockedBy: [] },
      { ...second, key: 'T-902', title: 'Downstream', blockedBy: [first.id] },
    ],
  };
  const page = await mount(
    <TicketsView map={map} filters={{ type: '', text: '' }} locked={() => false} send={() => {}} />,
  );
  const row = page.find(`[data-ticket-row="${first.id}"]`);
  expect(row).not.toBeNull();
  const drawn = row!.cloneNode(true) as HTMLElement;
  for (const control of drawn.querySelectorAll('select, input, button')) control.remove();
  expect(
    drawn.textContent,
    'outgoing blocking must be drawn, not just an available select option',
  ).toMatch(/T-902|Downstream/);
});

// Sol's proof on #1378 (round 1), retitled by what it proves; its body is Sol's.
it('distinct chat mention rows retain distinct conversation destinations in the web adapter', async () => {
  const entries = ['conv-shoot', 'conv-other'].map(
    (conversationId, index) =>
      ({
        id: `mention-${index}`,
        reason: 'mention',
        workState: 'open',
        access: 'readable',
        owed: true,
        counted: true,
        raisedAt: '2026-10-01T10:00:00Z',
        closedAt: null,
        seenAt: null,
        lastDelivery: null,
        conversation: {
          conversationId,
          kind: 'group',
          name: index === 0 ? 'Shoot crew' : 'Other crew',
        },
      }) satisfies InboxEntry,
  );
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url) => {
      const body = String(url).endsWith('/inbox/read') ? { inbox: entries } : { owed: 2 };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const places: string[] = [];
  const page = await mount(
    <InboxScreen
      client={client}
      grantKey="alpha:me"
      navigate={(place) => {
        places.push(place);
      }}
    />,
  );
  await until(page, () => page.all('a.nt__row').length === 2, 'two mention rows');
  const rows = page.all('a.nt__row');
  await act(() => {
    (rows[0] as HTMLElement).click();
    (rows[1] as HTMLElement).click();
  });
  expect(places).toHaveLength(2);
  expect(places[0], 'the selected conversation must survive navigation').not.toBe(places[1]);
});
/* eslint-enable require-unicode-regexp, max-lines-per-function, require-await */
