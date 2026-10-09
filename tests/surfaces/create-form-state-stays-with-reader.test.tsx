// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's New task form after a change of owner (WEB.md: a change of owner
// shows nothing of the last one). The last reader's lock, refusal text and
// in-flight create belong to that reader: the next business or person opens
// on a form that can be used.

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const refused = (): Promise<Response> =>
  Promise.resolve(
    Response.json(
      {
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
        names: ['task.create'],
        fixes: ['Ask an owner for the scope.'],
      },
      { status: 403 },
    ),
  );

/** A board whose `task.create` answers with `create`; every read answers empty. */
function board(create: () => Promise<Response>): typeof globalThis.fetch {
  return ((url: string | URL) => {
    const at = String(url);
    if (at.includes('/live?')) return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/inbox/read')) return Promise.resolve(Response.json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(Response.json({ ok: true, owed: 0 }));
    if (at.endsWith('/person/list'))
      return Promise.resolve(Response.json({ ok: true, persons: [] }));
    if (at.endsWith('/task/create')) return create();
    return Promise.resolve(Response.json({ ok: true, tasks: [], withheld: 0 }));
  }) as typeof globalThis.fetch;
}

const client = (businessKey: string, fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

const owners = [
  ['business to business', 'bravo', 'bravo:ada'],
  ['person to person', 'alpha', 'alpha:ben'],
] as const;

async function submitAsAda(create: () => Promise<Response>): Promise<Mounted> {
  const mounted = await mount(
    <Projects client={client('alpha', board(create))} grantKey="alpha:ada" navigate={() => {}} />,
  );
  await settle();
  await mounted.type('#create-title', 'Alpha task');
  await mounted.click('button[type="submit"]');
  await settle();
  return mounted;
}

it.each(owners)(
  '%s the last reader’s refusal neither locks nor speaks on the next form',
  async (_boundary, business, grant) => {
    view = await submitAsAda(refused);
    expect(view.find('.projects__create [role="alert"]')?.textContent).toContain(
      'SCOPE_NOT_GRANTED',
    );
    expect((view.find('#create-title') as HTMLInputElement).disabled).toBe(true);

    await view.render(
      <Projects client={client(business, board(refused))} grantKey={grant} navigate={() => {}} />,
    );
    await settle();
    expect(
      view.find('.projects__create [role="alert"]'),
      'the last reader’s refusal is drawn',
    ).toBeNull();
    expect((view.find('#create-title') as HTMLInputElement).disabled).toBe(false);
    expect((view.find('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  },
);

it.each(owners)(
  '%s the last reader’s create in flight does not hold the next form busy',
  async (_boundary, business, grant) => {
    view = await submitAsAda(() => new Promise<Response>(() => {}));
    expect(view.find('button[type="submit"]')?.textContent).toBe('Creating…');

    await view.render(
      <Projects client={client(business, board(refused))} grantKey={grant} navigate={() => {}} />,
    );
    await settle();
    expect(view.find('button[type="submit"]')?.textContent).toBe('Create task');
    expect((view.find('#create-title') as HTMLInputElement).disabled).toBe(false);
  },
);
