// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11, the drawer's session state: which subject the assistant talks about,
// which models it may offer, and what the ask seam and the tab row do to the
// open conversations. Everything here is `apps/web`'s, because drafts and open
// state belong to the application and not to the visual package; the drawer
// itself is drawn in `mp-7-11-drawer.test.tsx`.

import { describe, expect, it } from 'vitest';
import {
  FRESH_NOTE,
  addPage,
  ask,
  chooseModel,
  fresh,
  initial,
  openDirect,
  rename,
  select,
  takeOut,
  type AskEntry,
} from '../../apps/web/src/assistant/chats.ts';
import {
  LOCAL_MODEL_WAIT,
  modelOffer,
  subjectFor,
  type ModelChoice,
} from '../../apps/web/src/assistant/subject.ts';

const CATALOGUE: readonly ModelChoice[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
];
const MERIDIAN = { id: '11111111-1111-4111-8111-111111111111', name: 'Meridian Physio' };
const TASK = { id: '22222222-2222-4222-8222-222222222222', title: 'Fix the booking form' };

const entry = (overrides: Partial<AskEntry> = {}): AskEntry => ({
  row: 'CL-M03',
  widget: { id: 'clients-row-meridian', label: 'Meridian Physio, Clients' },
  question: 'What changed for Meridian this week?',
  scope: { client: MERIDIAN, task: null },
  ...overrides,
});

describe('MP-7-11 subject by route and scope', () => {
  it('an agency-wide page never talks about one client', () => {
    for (const route of ['agency:settings', 'agency:projects-board'] as const) {
      const subject = subjectFor({ route, client: null, task: null });
      expect(subject.kind).toBe('page');
      expect(subject.clientId).toBeNull();
      expect(subject.placeholder).not.toMatch(/client/iu);
      expect(subject.chips.join(' ')).not.toMatch(/client/iu);
    }
    expect(subjectFor({ route: 'agency:settings', client: null, task: null }).label).toBe(
      'Settings',
    );
  });

  it('a client in scope is the subject, and its placeholder says so', () => {
    const subject = subjectFor({ route: 'agency:projects-board', client: MERIDIAN, task: null });
    expect(subject).toMatchObject({ kind: 'client', clientId: MERIDIAN.id, label: MERIDIAN.name });
    expect(subject.placeholder).toBe('Ask about this client…');
  });

  it('a task in scope is the subject and carries its client for the egress rule', () => {
    const withClient = subjectFor({
      route: 'agency:task-detail',
      client: null,
      task: { ...TASK, clientId: MERIDIAN.id },
    });
    expect(withClient).toMatchObject({ kind: 'task', label: TASK.title, clientId: MERIDIAN.id });
    const internal = subjectFor({
      route: 'agency:task-detail',
      client: null,
      task: { ...TASK, clientId: null },
    });
    expect(internal.clientId).toBeNull();
  });
});

describe('MP-7-11 local model needed in plain words', () => {
  it('a client in scope is offered no cloud model, whatever the setting says until it is on', () => {
    const client = subjectFor({ route: 'agency:projects-board', client: MERIDIAN, task: null });
    for (const setting of [false, null]) {
      const offer = modelOffer(client, CATALOGUE, setting);
      expect(offer.models).toStrictEqual([]);
      expect(offer.waiting).toBe(LOCAL_MODEL_WAIT);
    }
    expect(LOCAL_MODEL_WAIT).toMatch(/waits on a local model/u);
    expect(LOCAL_MODEL_WAIT).toMatch(/nothing is sent/iu);
  });

  it('a task of a client is client material too', () => {
    const task = subjectFor({
      route: 'agency:task-detail',
      client: null,
      task: { ...TASK, clientId: MERIDIAN.id },
    });
    expect(modelOffer(task, CATALOGUE, null)).toStrictEqual({
      models: [],
      waiting: LOCAL_MODEL_WAIT,
    });
  });

  it('a page with no client in scope is offered the business catalogue', () => {
    const settings = subjectFor({ route: 'agency:settings', client: null, task: null });
    expect(modelOffer(settings, CATALOGUE, null)).toStrictEqual({
      models: CATALOGUE,
      waiting: null,
    });
  });
});

// eslint-disable-next-line max-lines-per-function -- the tab row's every move, one case each
describe('MP-7-11 drawer state', () => {
  it('MP-7-11 fresh tab', () => {
    const one = initial();
    expect(one.chats.map((chat) => chat.title)).toStrictEqual(['Chat 1']);
    const two = fresh(one);
    expect(two.chats.map((chat) => chat.title)).toStrictEqual(['Chat 1', 'Chat 2']);
    const opened = two.chats[1];
    expect(two.selected).toBe(opened?.key);
    expect(opened?.conversationId).toBeNull();
    expect(opened?.messages).toStrictEqual([
      { id: 'fresh', role: 'note', body: FRESH_NOTE, cites: [] },
    ]);
    expect(FRESH_NOTE).toBe('Fresh conversation — nothing carried over.');
    // Numbering never reuses a closed tab's number, so two tabs never share one.
    const three = fresh(takeOut(two, opened?.key ?? ''));
    expect(three.chats.map((chat) => chat.title)).toStrictEqual(['Chat 1', 'Chat 3']);
  });

  it('MP-7-11 switch conversations', () => {
    const two = chooseModel(fresh(initial()), initial().selected, 'claude-opus-5-5');
    const first = two.chats[0]?.key ?? '';
    const back = select(two, first);
    expect(back.selected).toBe(first);
    expect(back.chats[0]?.model).toBe('claude-opus-5-5');
    expect(back.chats[1]?.model).toBeNull();
    expect(select(back, 'no-such-tab')).toBe(back);
  });

  it('MP-7-11 conversation tabs: rename in place, 40 characters, blank reverts', () => {
    const one = initial();
    const key = one.selected;
    expect(rename(one, key, '  Booking form  ').chats[0]?.title).toBe('Booking form');
    expect(rename(one, key, 'x'.repeat(60)).chats[0]?.title).toBe('x'.repeat(40));
    expect(rename(one, key, '   ')).toBe(one);
  });

  it('MP-7-11 take out of tab row: the last one out opens a fresh one', () => {
    const two = fresh(initial());
    const out = takeOut(two, two.selected);
    expect(out.chats.map((chat) => chat.title)).toStrictEqual(['Chat 1']);
    expect(out.selected).toBe(out.chats[0]?.key);
    const none = takeOut(out, out.selected);
    expect(none.chats.map((chat) => chat.title)).toStrictEqual(['Chat 3']);
  });

  it('MP-7-11 model per conversation', () => {
    const one = initial();
    const chosen = chooseModel(one, one.selected, 'claude-sonnet-5-5');
    expect(chosen.chats[0]?.model).toBe('claude-sonnet-5-5');
    expect(chooseModel(one, 'no-such-tab', 'claude-sonnet-5-5')).toBe(one);
  });

  it('MP-7-11 page scope replaces: a second pointer replaces the first', () => {
    const one = initial();
    const first = addPage(one, one.selected, { address: '/settings', shows: 'Settings' });
    const second = addPage(first, one.selected, { address: '/projects/', shows: 'Projects' });
    expect(second.chats[0]?.page).toStrictEqual({ address: '/projects/', shows: 'Projects' });
    expect(second.chats[0]?.messages.filter((message) => message.id === 'page')).toHaveLength(1);
    expect(second.chats[0]?.messages.at(-1)?.body).toBe(
      'Read this page into context — every widget on /projects/, and nothing else.',
    );
  });
});

describe('MP-7-11 ask seam', () => {
  it('MP-7-11 widget cited: an ask opens a new chat with the question drafted', () => {
    const state = ask(initial(), entry());
    expect(state.chats).toHaveLength(2);
    expect(state.selected).toBe(state.chats[1]?.key);
    expect(state.draft).toBe('What changed for Meridian this week?');
    expect(state.citation).toStrictEqual({
      row: 'CL-M03',
      id: 'clients-row-meridian',
      label: 'Meridian Physio, Clients',
    });
    expect(state.scope).toStrictEqual({ client: MERIDIAN, task: null });
  });

  it('MP-7-11 sparkle entry: a second sparkle replaces the first citation', () => {
    const second = ask(
      ask(initial(), entry()),
      entry({
        row: 'TS-M05',
        widget: { id: 'running-test', label: 'Running test' },
        question: 'How is the running test doing?',
      }),
    );
    expect(second.citation?.id).toBe('running-test');
    expect(second.draft).toBe('How is the running test doing?');
    expect(JSON.stringify(second)).not.toContain('clients-row-meridian');
  });

  it('MP-7-11 sparkle entry: a direct open from the edge tab carries standing scope only', () => {
    const asked = ask(initial(), entry());
    const direct = openDirect(asked);
    expect(direct.citation).toBeNull();
    expect(direct.draft).toBe('');
    expect(direct.scope).toStrictEqual({ client: null, task: null });
    expect(direct.chats).toBe(asked.chats);
  });

  it('an entry naming no question or widget is refused rather than drafted blank', () => {
    const state = initial();
    expect(ask(state, entry({ question: '   ' }))).toBe(state);
    expect(ask(state, entry({ widget: { id: '', label: 'x' } }))).toBe(state);
  });
});
