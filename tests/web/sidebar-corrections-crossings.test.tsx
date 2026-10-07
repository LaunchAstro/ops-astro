// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The correction sidebar's separation crossings (#1122, Sol F4 on #1112):
// client to client within one business, person to person, and a business
// switch while an answer is out. Each case tries the crossing on a server
// stand-in that tells parties and sessions apart, with a control showing the
// same call reaches its own side.

import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import type { ProposePort } from '../../apps/web/src/assistant/correction.ts';
import {
  requestPort,
  type CorrectionTarget,
} from '../../apps/web/src/assistant/correction-desks.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import {
  ABOUT,
  ABOUT_FILE,
  V1,
  V2,
  aboutPage,
  askFor,
  card,
  refusal,
} from './sidebar-corrections-support.tsx';

afterEach(unmountAll);

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '44444444-4444-4444-8444-444444444444';

/** MOCK: client B's Pricing page, which client A's people hold no grant on. */
const PRICING_FILE: CorrectionTarget = {
  ...ABOUT_FILE,
  partyId: CLIENT_B,
  taskId: '55555555-5555-4555-8555-555555555555',
  path: 'src/pages/pricing.md',
  pageUrl: 'https://client-b.example.test/pricing',
  before: '# Pricing\n\nOur cheap plans suit small teams.\n',
};

interface Kept {
  readonly party: string;
  readonly state: string;
  readonly approver: string | null;
  readonly versionId: string;
}

/** Who holds a grant on which client, and the corrections the business holds. */
interface World {
  readonly grants: Readonly<Record<string, readonly string[]>>;
  readonly kept: Record<string, Kept>;
}

/**
 * The server's answer to one call under `session`. A correction is read or
 * decided only under a session whose grant covers its party, and any other
 * is not found, as `live-corrections.ts` filters inside its query. A request
 * on a party the session holds no grant on is refused.
 */
function answer(world: World, call: Call, nth: number): Response {
  const { path, session, body } = call;
  const covers = (party: string): boolean => (world.grants[session] ?? []).includes(party);
  if (path === '/live_correction/request') {
    const party = String(body['partyId']);
    if (!covers(party)) return refusal('SCOPE_NOT_GRANTED', 403);
    const correctionId = `c-${String(nth)}`;
    world.kept[correctionId] = { party, state: 'requested', approver: null, versionId: V1 };
    return json({
      recordId: correctionId,
      revision: 1,
      detail: { correctionId, state: 'requested' },
    });
  }
  const correctionId = String(body['correctionId']);
  const one = world.kept[correctionId];
  if (one === undefined || !covers(one.party)) return refusal('NOT_FOUND', 404);
  if (path === '/live_correction/read') {
    const { state, approver, versionId } = one;
    return json({ ok: true, correction: { correctionId, state, approver, versionId } });
  }
  if (path === '/live_correction/decide') return json({ recordId: correctionId, revision: 2 });
  return refusal('NOT_FOUND', 404);
}

interface Call {
  readonly path: string;
  readonly session: string;
  readonly body: Record<string, unknown>;
}

/**
 * One business's server stand-in that tells parties and people apart: each
 * call is answered under the session it carries (`answer`). `hold` keeps
 * every answer back until `release`, for an answer that lands late.
 */
function separated(
  businessKey: string,
  grants: Readonly<Record<string, readonly string[]>>,
  kept: Record<string, Kept>,
) {
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  let holding = false;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (!at.includes(`/api/b/${businessKey}/`)) throw new Error(`${businessKey} client sent ${at}`);
    const path = at.slice(at.indexOf(`/api/b/${businessKey}`) + `/api/b/${businessKey}`.length);
    const session = new Headers(init?.headers).get(SESSION_HEADER) ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, session, body });
    const answered = answer({ grants, kept }, { path, session, body }, calls.length);
    if (!holding) return Promise.resolve(answered);
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(answered);
      });
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    as: (sessionId: string) =>
      new OperationsClient({ origin: '', businessKey, signedIn: true, sessionId, fetch }),
    sent: (path: string) => calls.filter((call) => call.path === path),
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      for (const go of held.splice(0)) go();
      await tick();
    },
  };
}

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

/** The drawer as App mounts it (App.tsx): keyed on the grant key, so a new person gets a new one. */
const drawerFor = (who: { readonly client: OperationsClient; readonly grantKey: string }) => (
  <AssistantView
    key={who.grantKey}
    grantKey={who.grantKey}
    client={who.client}
    route="agency:projects-board"
    here="/projects"
    entry={null}
    locate={aboutPage}
  />
);

describe('person to person: a person signed in after another never sees the first one’s corrections', () => {
  const people = () => {
    const alpha = separated('alpha', { 'session-p1': [CLIENT_A], 'session-p2': [CLIENT_A] }, {});
    return {
      alpha,
      p1: { client: alpha.as('session-p1'), grantKey: 'alpha:p1@example.test:0' },
      p2: { client: alpha.as('session-p2'), grantKey: 'alpha:p2@example.test:0' },
    };
  };

  it('a card held for one person is gone when the next person signs in', async () => {
    const { p1, p2 } = people();
    const view = await mount(drawerFor(p1));
    await tick();
    await askFor(view, ABOUT);
    expect(view.all('[data-correction-card]')).toHaveLength(1);
    await view.render(drawerFor(p2));
    await tick();
    expect(view.find('[data-correction-door]')).not.toBeNull();
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    expect(view.text()).not.toContain('alongside');
  });

  it('the first person’s late answer lands nowhere the next person sees', async () => {
    const { alpha, p1, p2 } = people();
    const view = await mount(drawerFor(p1));
    await tick();
    alpha.hold();
    await askFor(view, ABOUT);
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    await view.render(drawerFor(p2));
    await tick();
    await alpha.release();
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    expect(view.text()).not.toContain('alongside');
    expect(alpha.sent('/live_correction/request').map((call) => call.session)).toStrictEqual([
      'session-p1',
    ]);
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
