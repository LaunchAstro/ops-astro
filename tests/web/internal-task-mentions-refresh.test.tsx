// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import {
  Harness,
  PEOPLE,
  deferredResponse,
  mentionAda,
  open,
  refusal,
  response,
  transport,
} from './internal-task-mentions-support.tsx';

const chooser = '[data-internal-task-mentions] button[aria-haspopup="listbox"]';
const online = () =>
  act(() => {
    window.dispatchEvent(new Event('online'));
  });

it('same-owner refresh hides previous names while pending and retires a superseded late answer', async () => {
  const server = transport();
  const held = deferredResponse();
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const view = await open({ client: server.client, grantKey: 'same-owner' });
  try {
    await mentionAda(view);
    expect(view.text()).toContain('Ada Synthetic');
    server.answers.people = () => held.promise;
    await online();
    expect(view.text()).not.toContain('Ada Synthetic');
    expect(view.text()).not.toContain('Bea Synthetic');
    expect(view.host.querySelector(chooser)).toBeNull();
    expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
    expect(view.find('[data-mention-clear]')).toHaveProperty('disabled', false);
    await online();
    now = 90_000;
    server.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
    await online();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
    await view.type('#comment-body', 'Do not send a hidden old recipient');
    await view.click('[data-comment="post"]');
    expect(server.posts()).toEqual([]);
    await act(() => {
      held.resolve(response(PEOPLE));
    });
    expect(view.text()).not.toContain('Ada Synthetic');
    expect(view.text()).not.toContain('Bea Synthetic');
    expect(view.host.querySelector(chooser)).toBeNull();
    expect(server.posts()).toEqual([]);
    await view.click('[data-mention-clear]');
    await view.type('#comment-body', 'Ordinary note after vocabulary revoke');
    await view.click('[data-comment="post"]');
    expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
  } finally {
    clock.mockRestore();
  }
});

it('same-client grant change drops selected names and retires a late post without closing the new composer', async () => {
  const server = transport();
  const held = deferredResponse();
  const view = await open({ client: server.client, grantKey: 'before' });
  await mentionAda(view);
  await view.type('#comment-body', 'Old grant note');
  server.answers.comment = () => held.promise;
  await view.click('[data-comment="post"]');
  server.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
  await view.render(<Harness client={server.client} grantKey="after" />);
  expect(view.text()).not.toContain('Ada Synthetic');
  expect(view.find('#comment-body')).toHaveProperty('value', '');
  await view.type('#comment-body', 'New grant note');
  await act(() => {
    held.resolve(refusal('SCOPE_NOT_GRANTED'));
  });
  expect(view.find('#comment-body')).toHaveProperty('value', 'New grant note');
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', false);
  expect(server.posts()).toHaveLength(1);
});
