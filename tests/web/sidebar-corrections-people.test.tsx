// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The correction sidebar, person to person (#1122, Sol F4 on #1112). The
// hook holds each card and each late answer under the grant it was made in
// (business, person and session, `grantKeyOf`), so a person signed in after
// another sees none of the first one's corrections: on the same drawer
// re-rendered with the next grant, and on App's path, which remounts the
// drawer keyed on the grant (App.tsx).

import { afterEach, describe, expect, it } from 'vitest';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { ABOUT, aboutPage, askFor } from './sidebar-corrections-support.tsx';
import { CLIENT_A, separated } from './sidebar-corrections-server.tsx';

afterEach(unmountAll);

interface Person {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

/** The drawer for one person's grant, the same instance across a re-render. */
const drawer = (who: Person) => (
  <AssistantView
    grantKey={who.grantKey}
    client={who.client}
    route="agency:projects-board"
    here="/projects"
    entry={null}
    locate={aboutPage}
  />
);

/** The drawer as App mounts it (App.tsx): keyed on the grant, so a new person gets a new one. */
const keyedDrawer = (who: Person) => (
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

/** Two people in Alpha, each on their own session, both holding a grant on client A. */
const people = () => {
  const alpha = separated('alpha', { 'session-p1': [CLIENT_A], 'session-p2': [CLIENT_A] }, {});
  return {
    alpha,
    p1: { client: alpha.as('session-p1'), grantKey: 'alpha:p1@example.test:0' },
    p2: { client: alpha.as('session-p2'), grantKey: 'alpha:p2@example.test:0' },
  };
};

const cards = (view: Awaited<ReturnType<typeof mount>>): number =>
  view.all('[data-correction-card]').length;

describe('person to person on the same drawer: the hook holds each card under its grant', () => {
  it('a card held for one person is gone when the next person signs in, and is back under the first one’s grant', async () => {
    const { p1, p2 } = people();
    const view = await mount(drawer(p1));
    await tick();
    await askFor(view, ABOUT);
    expect(cards(view)).toBe(1);
    await view.render(drawer(p2));
    await tick();
    expect(view.find('[data-correction-door]')).not.toBeNull();
    expect(cards(view)).toBe(0);
    expect(view.text()).not.toContain('alongside');
    await view.render(drawer(p1));
    await tick();
    expect(cards(view)).toBe(1);
  });

  it('the first person’s late answer lands under their grant, nowhere the next person sees', async () => {
    const { alpha, p1, p2 } = people();
    const view = await mount(drawer(p1));
    await tick();
    alpha.hold();
    await askFor(view, ABOUT);
    expect(cards(view)).toBe(0);
    await view.render(drawer(p2));
    await tick();
    await alpha.release();
    expect(cards(view)).toBe(0);
    expect(view.text()).not.toContain('alongside');
    expect(alpha.sent('/live_correction/request').map((call) => call.session)).toStrictEqual([
      'session-p1',
    ]);
    await view.render(drawer(p1));
    await tick();
    expect(cards(view)).toBe(1);
  });
});

describe('person to person on App’s path: the drawer keyed on the grant', () => {
  it('the first person’s late answer lands nowhere the next person sees', async () => {
    const { alpha, p1, p2 } = people();
    const view = await mount(keyedDrawer(p1));
    await tick();
    alpha.hold();
    await askFor(view, ABOUT);
    await view.render(keyedDrawer(p2));
    await tick();
    await alpha.release();
    expect(cards(view)).toBe(0);
    expect(view.text()).not.toContain('alongside');
  });
});
