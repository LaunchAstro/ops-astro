// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Mounted } from '../surfaces/mount.tsx';
import {
  Harness,
  PEOPLE,
  deferredResponse,
  key,
  mentionAda,
  open,
  refusal,
  response,
  transport,
} from './internal-task-mentions-support.tsx';

const online = () =>
  act(() => {
    window.dispatchEvent(new Event('online'));
  });

/**
 * A new at-sign query with Enter, as a person picks the first name offered:
 * the body is unchanged when the composer offers no name.
 */
async function pickFirstOffered(view: Mounted): Promise<void> {
  await view.type('#comment-body', '@Ada Synthetic @B');
  await key(view, '#comment-body', 'Enter');
}

it('same-owner refresh hides previous names while pending and retires a superseded late answer', async () => {
  const server = transport();
  const held = deferredResponse();
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const view = await open({ client: server.client, grantKey: 'same-owner' });
  try {
    await mentionAda(view);
    expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic ');
    server.answers.people = () => held.promise;
    await online();
    // Pending, the last answer's names are not offered: no option, and Enter
    // completes no name.
    await pickFirstOffered(view);
    expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic @B');
    expect(view.text()).not.toContain('Bea Synthetic');
    expect(view.find('[data-internal-task-mentions] [role=option]')).toBeNull();
    expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
    expect(view.find('[data-mention-clear]')).toHaveProperty('disabled', false);
    await online();
    now = 90_000;
    server.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
    await online();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
    await view.type('#comment-body', '@Ada Synthetic Do not send a hidden old recipient');
    await view.click('[data-comment="post"]');
    expect(server.posts()).toEqual([]);
    await act(() => {
      held.resolve(response(PEOPLE));
    });
    // The superseded late answer offers no names either.
    await pickFirstOffered(view);
    expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic @B');
    expect(view.text()).not.toContain('Bea Synthetic');
    expect(view.find('[data-internal-task-mentions] [role=option]')).toBeNull();
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
  await view.type('#comment-body', '@Ada Synthetic Old grant note');
  server.answers.comment = () => held.promise;
  await view.click('[data-comment="post"]');
  server.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
  await view.render(<Harness client={server.client} grantKey="after" />);
  // The new composer holds no selected name: a held one, with the new grant's
  // people refused, would draw Clear mentions and hold the post.
  expect(view.find('[data-mention-clear]')).toBeNull();
  expect(view.find('#comment-body')).toHaveProperty('value', '');
  await view.type('#comment-body', 'New grant note');
  await act(() => {
    held.resolve(refusal('SCOPE_NOT_GRANTED'));
  });
  expect(view.find('#comment-body')).toHaveProperty('value', 'New grant note');
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', false);
  expect(server.posts()).toHaveLength(1);
  // The new composer's post carries none of the old grant's mention ids.
  server.answers.comment = () => Promise.resolve(response({ recordId: 'task-one', revision: 5 }));
  await view.click('[data-comment="post"]');
  expect(server.posts()).toHaveLength(2);
  expect(server.posts()[1]?.body).toMatchObject({ body: 'New grant note', audience: 'internal' });
  expect(server.posts()[1]?.body).not.toHaveProperty('mentions');
});
