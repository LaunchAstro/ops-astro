// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The sidebar's one-word site correction: the request door, the desks and the
// card. The request goes through the one typed port the hook takes; the port
// here is a labelled mock, since `site.source.propose` is not on this build.
// The card's state is what `live_correction.read` answers, and its only
// controls are a person's approve and decline through `live_correction.decide`.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { CorrectionAsk, ProposePort } from '../../apps/web/src/assistant/correction.ts';
import {
  requestPort,
  type CorrectionTarget,
} from '../../apps/web/src/assistant/correction-desks.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

/** One business's API: the correction states its read answers, and every call it was sent. */
function business(businessKey: string, state: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (!at.includes(`/api/b/${businessKey}/`)) throw new Error(`${businessKey} client sent ${at}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const path = at.slice(at.indexOf(`/api/b/${businessKey}`) + `/api/b/${businessKey}`.length);
    calls.push({ path, body });
    if (path === '/live_correction/read') {
      const correctionId = String(body['correctionId']);
      const approver = state === 'requested' ? null : 'Grace Hopper';
      return Promise.resolve(
        json({
          ok: true,
          correction: { correctionId, state, approver, versionId: `v-${correctionId}` },
        }),
      );
    }
    if (path === '/live_correction/request') {
      if (state === 'refuse-request') {
        return Promise.resolve(
          json({ refused: true, code: 'CORRECTION_PARTY_MISMATCH', names: [], fixes: [] }, 409),
        );
      }
      const correctionId = `c-${String(calls.length)}`;
      return Promise.resolve(
        json({ recordId: correctionId, revision: 1, detail: { correctionId, state: 'requested' } }),
      );
    }
    if (path === '/live_correction/decide') {
      return Promise.resolve(json({ recordId: String(body['correctionId']), revision: 2 }));
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  return { client, calls };
}

/**
 * MOCK: stands in for the sidebar's `site.source.propose` until that command
 * is on main. It answers each ask with the next made-up id, or the given code.
 */
function mockPropose(refusal: string | null = null) {
  const asked: CorrectionAsk[] = [];
  const port: ProposePort = (ask) => {
    asked.push(ask);
    return Promise.resolve(
      refusal === null
        ? { ok: true, correctionId: `mock-correction-${String(asked.length)}` }
        : { ok: false, code: refusal },
    );
  };
  return { port, asked };
}

type View = Awaited<ReturnType<typeof mount>>;

async function askFor(view: View, ask: CorrectionAsk): Promise<void> {
  await view.type('[data-correction-door] [name="page"]', ask.page);
  await view.type('[data-correction-door] [name="word"]', ask.word);
  await view.type('[data-correction-door] [name="replacement"]', ask.replacement);
  await view.click('[data-correction-ask]');
  await tick();
}

const ABOUT = { page: 'About', word: 'alongside', replacement: 'beside' };

const controls = (view: View): string[] =>
  view.all('[data-correction-card] button').map((button) => button.textContent ?? '');

describe('the correction card says the state main’s read answers', () => {
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ['requested', 'requested', /waiting for the configured approver/iu],
    ['approved', 'approved', /approved/iu],
    ['live', 'published', /published/iu],
    ['reverted', 'reverted', /reverted/iu],
    ['failed', 'failed', /failed/iu],
    ['unknown', 'unknown', /not known/iu],
    ['some-state-not-named', 'unknown', /not known/iu],
  ];
  it.each(cases)('a read answering %s draws the card as %s', async (read, drawn, words) => {
    const { client } = business('alpha', read);
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    const card = view.find('[data-correction-card]');
    expect((card as HTMLElement | null)?.dataset['correctionState']).toBe(drawn);
    expect(card?.querySelector('[data-correction-words]')?.textContent).toMatch(words);
    expect(card?.textContent).toContain('alongside');
    expect(card?.textContent).toContain('beside');
  });
});

describe('the card never publishes; a person decides through the decision path', () => {
  it('no card offers publish, and only a waiting card offers approve and decline', async () => {
    for (const state of ['approved', 'live', 'reverted', 'failed', 'unknown']) {
      const { client } = business('alpha', state);
      // oxlint-disable-next-line no-await-in-loop
      const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
      // oxlint-disable-next-line no-await-in-loop
      await askFor(view, ABOUT);
      expect(controls(view), state).toStrictEqual([]);
      // oxlint-disable-next-line no-await-in-loop
      await view.unmount();
    }
    const { client } = business('alpha', 'requested');
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    expect(controls(view)).toStrictEqual(['Approve', 'Decline']);
    expect(view.text()).not.toMatch(/publish now|publish this/iu);
  });

  it('approve sends the person’s decision on the version read, and nothing else is written', async () => {
    const { client, calls } = business('alpha', 'requested');
    const view = await mount(<SidebarCorrections client={client} propose={mockPropose().port} />);
    await askFor(view, ABOUT);
    await view.click('[data-correction-decide="approve"]');
    await tick();
    const decided = calls.filter((call) => call.path === '/live_correction/decide');
    expect(decided.map((call) => call.body)).toMatchObject([
      { correctionId: 'mock-correction-1', versionId: 'v-mock-correction-1', decision: 'approve' },
    ]);
    const paths = new Set(calls.map((call) => call.path));
    expect([...paths].toSorted()).toStrictEqual([
      '/live_correction/decide',
      '/live_correction/read',
    ]);
  });
});

describe('the request door', () => {
  it('sends the three fields through the port', async () => {
    const { client } = business('alpha', 'requested');
    const mock = mockPropose();
    const view = await mount(<SidebarCorrections client={client} propose={mock.port} />);
    await askFor(view, ABOUT);
    expect(mock.asked).toStrictEqual([ABOUT]);
  });

  it('says a refusal’s code in plain words, never the code', async () => {
    const { client } = business('alpha', 'requested');
    const refused = mockPropose('CHANGE_ENVELOPE_EXCEEDED');
    const view = await mount(<SidebarCorrections client={client} propose={refused.port} />);
    await askFor(view, ABOUT);
    const said = view.find('[data-correction-refusal]')?.textContent ?? '';
    expect(said).toMatch(/one word for one word/iu);
    expect(view.text()).not.toContain('CHANGE_ENVELOPE_EXCEEDED');
    expect(view.find('[data-correction-card]')).toBeNull();
  });

  it('says a code it does not know as nothing sent, never the code', async () => {
    const { client } = business('alpha', 'requested');
    const refused = mockPropose('SOMETHING_NEW_FROM_THE_PROVIDER');
    const view = await mount(<SidebarCorrections client={client} propose={refused.port} />);
    await askFor(view, ABOUT);
    const said = view.find('[data-correction-refusal]')?.textContent ?? '';
    expect(said).toMatch(/nothing was sent/iu);
    expect(view.text()).not.toContain('SOMETHING_NEW');
  });
});

describe('the desks hold the active business’s corrections only', () => {
  it('a correction asked in Alpha is not on Bravo’s desks, and is back on Alpha’s', async () => {
    const alpha = business('alpha', 'requested');
    const bravo = business('bravo', 'requested');
    const mock = mockPropose();
    const view = await mount(<SidebarCorrections client={alpha.client} propose={mock.port} />);
    await askFor(view, ABOUT);
    expect(view.all('[data-correction-card]')).toHaveLength(1);
    await view.render(<SidebarCorrections client={bravo.client} propose={mock.port} />);
    await tick();
    expect(view.all('[data-correction-card]')).toHaveLength(0);
    expect(view.text()).not.toContain('alongside');
    await view.render(<SidebarCorrections client={alpha.client} propose={mock.port} />);
    await tick();
    expect(view.all('[data-correction-card]')).toHaveLength(1);
    expect(bravo.calls).toStrictEqual([]);
  });
});

/** MOCK: the site read that finds the About page's file, until one is on main. */
const ABOUT_FILE: CorrectionTarget = {
  partyId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  path: 'src/pages/about.md',
  pageUrl: 'https://client.example.test/about',
  baseRevision: 'abc123',
  before: '# About\n\nWe work alongside the teams who run your website.\n',
};
const aboutPage = (ask: CorrectionAsk): Promise<CorrectionTarget | null> =>
  Promise.resolve(ask.page === 'About' ? ABOUT_FILE : null);

describe('the door on the real command client', () => {
  it('sends live_correction.request with the located file and the one word changed', async () => {
    const { client, calls } = business('alpha', 'requested');
    const view = await mount(
      <SidebarCorrections client={client} propose={requestPort(client, aboutPage)} />,
    );
    await askFor(view, ABOUT);
    const sent = calls.filter((call) => call.path === '/live_correction/request');
    expect(sent).toHaveLength(1);
    const { operationId: _id, ...operands } = sent[0]?.body ?? {};
    expect(operands).toStrictEqual({
      ...ABOUT_FILE,
      word: 'alongside',
      replacement: 'beside',
      after: '# About\n\nWe work beside the teams who run your website.\n',
    });
    expect(
      (view.find('[data-correction-card]') as HTMLElement | null)?.dataset['correctionState'],
    ).toBe('requested');
  });

  it('says the command’s refusal in plain words, never its code', async () => {
    const { client } = business('alpha', 'refuse-request');
    const view = await mount(
      <SidebarCorrections client={client} propose={requestPort(client, aboutPage)} />,
    );
    await askFor(view, ABOUT);
    expect(view.find('[data-correction-refusal]')?.textContent).toMatch(/another client/iu);
    expect(view.text()).not.toContain('CORRECTION_PARTY_MISMATCH');
  });

  it('decide sends for the correction whose card was pressed, and no other', async () => {
    const { client, calls } = business('alpha', 'requested');
    const view = await mount(
      <SidebarCorrections client={client} propose={requestPort(client, aboutPage)} />,
    );
    await askFor(view, ABOUT);
    await askFor(view, { ...ABOUT, word: 'teams', replacement: 'people' });
    const ids = calls.filter((call) => call.path === '/live_correction/read');
    const second = String(ids[1]?.body['correctionId']);
    await view.click(`[data-correction-card]:nth-of-type(2) [data-correction-decide="reject"]`);
    await tick();
    const decided = calls.filter((call) => call.path === '/live_correction/decide');
    expect(decided.map(({ body: { operationId: _o, ...rest } }) => rest)).toStrictEqual([
      { correctionId: second, versionId: `v-${second}`, decision: 'reject' },
    ]);
  });
});

describe('the assistant sidebar', () => {
  it('sends the door’s ask as live_correction.request when handed the site read, and draws no door without', async () => {
    const { client, calls } = business('alpha', 'requested');
    const drawer = (locate?: typeof aboutPage) => (
      <AssistantView
        client={client}
        route="agency:projects-board"
        here="/projects"
        entry={null}
        {...(locate === undefined ? {} : { locate })}
      />
    );
    const view = await mount(drawer(aboutPage));
    await tick();
    expect(view.find('[data-assistant="corrections"] [data-correction-door]')).not.toBeNull();
    await askFor(view, ABOUT);
    expect(calls.filter((call) => call.path === '/live_correction/request')).toHaveLength(1);
    await view.render(drawer());
    await tick();
    expect(view.find('[data-assistant="corrections"]')).toBeNull();
  });
});
