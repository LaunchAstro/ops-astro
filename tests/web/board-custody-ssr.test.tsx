// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BoardCustody } from '../../apps/web/src/screens/projects/board-custody.tsx';

const screen = (drawn: boolean) => (
  <BoardCustody drawn={drawn} clear={false}>
    <input aria-label="Unsent editor" defaultValue="Original" />
  </BoardCustody>
);

it('the server and first client share a host before mounting a stable withdrawable editor', async () => {
  const markup = renderToString(screen(true));
  expect(markup).toBe('<div></div>');
  const host = document.createElement('div');
  host.innerHTML = markup;
  document.body.append(host);
  const firstHost = host.firstElementChild;
  const errors: unknown[] = [];
  const root = hydrateRoot(host, screen(true), {
    onRecoverableError: (error) => errors.push(error),
  });
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.firstElementChild).toBe(firstHost);
    const editor = host.querySelector('input');
    expect(editor).not.toBeNull();
    if (editor === null) throw new Error('The client did not mount the editor.');
    editor.value = 'Unsent';
    editor.focus();
    await act(() => {
      root.render(screen(false));
    });
    expect(host.querySelector('input')).toBeNull();
    await act(() => {
      root.render(screen(true));
    });
    expect(host.querySelector('input')).toBe(editor);
    expect(editor.value).toBe('Unsent');
    expect(document.activeElement).toBe(editor);
    expect(errors).toEqual([]);
  } finally {
    await act(() => {
      root.unmount();
    });
    host.remove();
  }
});
