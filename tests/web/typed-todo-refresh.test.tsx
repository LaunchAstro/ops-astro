// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { act } from 'react';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { person, clientId, transport } from './typed-todo-scope-support.tsx';
import { changing, key, refresh } from './typed-todo-refresh-support.tsx';
it('committed names follow current permission vocabulary and revocation removes chips, counts and rows', async () => {
  const t = changing();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await view.type('#todos-search', 'PERSON:"noah lee" CLIENT:"acme physio"');
  await key(view, '#todos-search', 'Enter');
  expect(view.find('[data-todos-chip="person"]')?.textContent).toContain('Noah Lee');
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('7 messages');
  t.rename();
  await refresh();
  expect(view.find('[data-todos-chip="person"]')?.textContent).toContain('Current permitted name');
  expect(view.text()).not.toContain('Noah Lee');
  t.revoke();
  await refresh();
  expect(view.text()).not.toContain('Current permitted name');
  expect(view.text()).not.toContain('Acme Physio');
  expect(view.all('[data-todos-identity]')).toHaveLength(0);
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.find('[data-todos-waiting-count]')).toBeNull();
});

it('committed ambiguity drops revoked choices without reading a wider task scope', async () => {
  const t = changing();
  t.ambiguous();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await view.type('#todos-search', 'person:"Noah Lee"');
  await key(view, '#todos-search', 'Enter');
  expect(view.all('[data-todos-identity]')).toHaveLength(2);
  const before = t.reads.length;
  t.revoke();
  await refresh();
  expect(view.all('[data-todos-identity]')).toHaveLength(0);
  expect(view.text()).not.toContain('Noah Lee');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(t.reads).toHaveLength(before);
});

it('waiting counts use the effective typed client, route, words and comment focus row set', async () => {
  const t = changing();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await view.type('#todos-search', 'client:"Acme Physio" person:"Noah Lee" route:review');
  expect(view.all('[data-todo-row]')).toHaveLength(1);
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('2 messages');
  await view.type('#todos-search', 'client:"Acme Physio" route:team missing');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.find('[data-todos-waiting-count]')).toBeNull();
  await view.type('#todos-search', 'client:"Acme Physio" waiting');
  await view.click('[data-todo-row="Review"] [data-todo-comments]');
  expect(view.all('[data-todo-row]')).toHaveLength(1);
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('2 messages');
});

it('same mounted owner task grant revocation hides rows at the existing refresh boundary', async () => {
  const t = changing();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await view.type('#todos-search', 'person:"Noah Lee"');
  expect(view.all('[data-todo-row]')).toHaveLength(2);
  t.revokeTasks();
  await refresh();
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.find('[data-todos-waiting-count]')).toBeNull();
});

it('malformed identity quotes and unknown routes block rows without issuing a default read', async () => {
  const t = changing();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  const before = t.reads.length;
  for (const query of ['person:"Noah', 'route:unrecognised', 'person:"Noah Lee" person:Someone']) {
    // eslint-disable-next-line no-await-in-loop -- one user changes the same search control in order.
    await view.type('#todos-search', query);
    expect(view.all('[data-todo-row]')).toHaveLength(0);
    expect(t.reads).toHaveLength(before);
  }
});

it('empty Backspace and chip removal return to own scope through keyboard controls', async () => {
  const t = transport();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await view.type('#todos-search', 'person:"Noah Lee" client:"Acme Physio"');
  await key(view, '#todos-search', 'Enter');
  await key(view, '#todos-search', 'Backspace');
  expect(t.reads.at(-1)).toEqual({ person });
  await view.click('[data-todos-chip-remove]');
  expect(t.reads.at(-1)).toEqual({});
});

it('a pending permission refresh hides prior names and rows, and its late answer cannot undo revocation', async () => {
  const t = changing();
  const screen = (changes: number) => (
    <TodosScreen client={t.client} grantKey="synthetic:owner" changes={changes} />
  );
  const view = await mount(screen(0));
  await view.type('#todos-search', 'person:"Noah Lee" client:"Acme Physio"');
  await key(view, '#todos-search', 'Enter');
  const release = t.holdPeople();
  await refresh();
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.find('[data-todos-waiting-count]')).toBeNull();
  expect(view.text()).not.toContain('Noah Lee');
  expect(view.text()).not.toContain('Acme Physio');
  t.revoke();
  await view.render(screen(1));
  await settle();
  await act(() => {
    release();
  });
  await settle();
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Noah Lee');
  expect(view.text()).not.toContain('Acme Physio');
});

it.each(['waiting then route', 'route then waiting'])(
  'client narrowing intersects %s',
  async (order) => {
    const t = changing();
    t.addUnwaiting();
    const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
    await view.choose('#todos-client', clientId);
    if (order === 'waiting then route') {
      await view.click('#todos-waiting');
      await view.choose('#todos-family', 'Review');
    } else {
      await view.choose('#todos-family', 'Review');
      await view.click('#todos-waiting');
    }
    expect(view.all('[data-todo-row]')).toHaveLength(1);
    expect(view.find('[data-todo-row="Review"]')).not.toBeNull();
    expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('2 messages');
    expect(view.find('[data-todos-reading]')?.textContent).toContain('waiting');
    expect(view.find('[data-todos-reading]')?.textContent).toContain('Review');
    await view.choose('#todos-family', '');
    expect(view.all('[data-todo-row]')).toHaveLength(2);
    expect(view.host.querySelector<HTMLInputElement>('#todos-waiting')?.checked).toBe(true);
  },
);
