// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The correction sidebar's separation crossings (#1122, Sol F4 on #1112):
// client to client within one business, and a business switch while an
// answer is out. Each case tries the crossing on a server stand-in that tells
// parties and sessions apart, with a control showing the same call reaches
// its own side. Person to person is in sidebar-corrections-people.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import type { ProposePort } from '../../apps/web/src/assistant/correction.ts';
import {
  requestPort,
  type CorrectionTarget,
} from '../../apps/web/src/assistant/correction-desks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import {
  ABOUT,
  ABOUT_FILE,
  V1,
  V2,
  aboutPage,
  askFor,
  card,
} from './sidebar-corrections-support.tsx';
import { CLIENT_A, CLIENT_B, separated } from './sidebar-corrections-server.tsx';

afterEach(unmountAll);

/** MOCK: client B's Pricing page, which client A's people hold no grant on. */
const PRICING_FILE: CorrectionTarget = {
  ...ABOUT_FILE,
  partyId: CLIENT_B,
  taskId: '55555555-5555-4555-8555-555555555555',
  path: 'src/pages/pricing.md',
  pageUrl: 'https://client-b.example.test/pricing',
  before: '# Pricing\n\nOur cheap plans suit small teams.\n',
};

/** A port that answers each ask with the given correction ids in turn. */
const answering =
  (...ids: string[]): ProposePort =>
  () => {
    const correctionId = ids.shift();
    return Promise.resolve(
      correctionId === undefined ? { ok: false, code: 'UNAVAILABLE' } : { ok: true, correctionId },
    );
  };

/** Alpha with two clients: A's correction waits, B's was approved by B's own approver. */
const twoClients = () =>
  separated(
    'alpha',
    { 'session-a': [CLIENT_A], 'session-b': [CLIENT_B] },
    {
      'c-client-a': { party: CLIENT_A, state: 'requested', approver: null, versionId: V1 },
      'c-client-b': { party: CLIENT_B, state: 'approved', approver: 'Bea Okafor', versionId: V2 },
    },
  );

describe('client to client: one client’s person never reaches another client’s correction', () => {
  it('a read of client B’s correction from client A’s session is not found, and B’s state, approver and version are never drawn or sent', async () => {
    const alpha = twoClients();
    const client = alpha.as('session-a');
    const view = await mount(
      <SidebarCorrections client={client} propose={answering('c-client-b', 'c-client-a')} />,
    );
    await askFor(view, { page: 'Pricing', word: 'cheap', replacement: 'fair' });
    const crossed = card(view);
    expect(crossed?.dataset['correctionState']).toBe('requested');
    expect(crossed?.querySelector('[role="alert"]')?.textContent).toMatch(
      /not one you can reach/iu,
    );
    expect(view.text()).not.toContain('Bea Okafor');
    expect(crossed?.querySelector('[data-correction-words]')?.textContent).not.toMatch(
      /approved/iu,
    );
    expect(view.all('[data-correction-decide]')).toHaveLength(0);
    await askFor(view, ABOUT);
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(alpha.sent('/live_correction/decide').map((call) => call.body)).toMatchObject([
      { correctionId: 'c-client-a', versionId: V1, decision: 'approve' },
    ]);
    expect(view.text()).not.toContain('Bea Okafor');
  });
});

describe('client to client: the grant is what keeps them apart', () => {
  it('the same read under client B’s own session draws B’s card, so the refusal above is the grant', async () => {
    const alpha = twoClients();
    const view = await mount(
      <SidebarCorrections client={alpha.as('session-b')} propose={answering('c-client-b')} />,
    );
    await askFor(view, { page: 'Pricing', word: 'cheap', replacement: 'fair' });
    expect(card(view)?.dataset['correctionState']).toBe('approved');
    expect(view.text()).toContain('Decided by Bea Okafor.');
  });

  it('a request from client A’s session on client B’s page is refused, and no card is drawn', async () => {
    const alpha = twoClients();
    const client = alpha.as('session-a');
    const pricingPage = (): Promise<CorrectionTarget | null> => Promise.resolve(PRICING_FILE);
    const view = await mount(
      <SidebarCorrections client={client} propose={requestPort(client, pricingPage)} />,
    );
    await askFor(view, { page: 'Pricing', word: 'cheap', replacement: 'fair' });
    expect(alpha.sent('/live_correction/request')).toHaveLength(1);
    expect(view.find('[data-correction-refusal]')?.textContent).toMatch(/do not hold the grant/iu);
    expect(card(view)).toBeNull();
    expect(alpha.sent('/live_correction/read')).toStrictEqual([]);
  });
});

/** The sidebar on one business's client, its door sending through the real request port. */
const sidebar = (client: OperationsClient) => (
  <SidebarCorrections client={client} propose={requestPort(client, aboutPage)} />
);

describe('a business switch while an answer is out', () => {
  it('a request sent in Alpha whose answer lands after the switch to Bravo lands on Alpha only', async () => {
    const alpha = separated('alpha', { s: [CLIENT_A] }, {});
    const bravo = separated('bravo', { s: [CLIENT_A] }, {});
    const inAlpha = alpha.as('s');
    const inBravo = bravo.as('s');
    const view = await mount(sidebar(inAlpha));
    alpha.hold();
    await askFor(view, ABOUT);
    expect(alpha.sent('/live_correction/request')).toHaveLength(1);
    await view.render(sidebar(inBravo));
    await tick();
    await alpha.release();
    await tick();
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    expect(view.text()).not.toContain('alongside');
    expect(view.find('[data-correction-refusal]')).toBeNull();
    expect(bravo.sent('/live_correction/read')).toStrictEqual([]);
    await view.render(sidebar(inAlpha));
    await tick();
    expect(view.all('[data-correction-card]')).toHaveLength(1);
    expect(card(view)?.dataset['correctionState']).toBe('requested');
    expect(alpha.sent('/live_correction/read')).toHaveLength(1);
  });
});
