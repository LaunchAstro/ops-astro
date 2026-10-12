// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { Conversation } from '../../packages/ui/src/surfaces/TeamConversation.tsx';
import { mount } from './mount.tsx';

/* eslint-disable no-promise-executor-return, require-await -- Sol's proof, kept as written */
// Sol's proof on #1378 (round 2), retitled by what it proves; its body is Sol's.
it('overlapping failed sends keep every message beside newer words', async () => {
  const replies: Array<(sent: boolean) => void> = [];
  const page = await mount(
    <Conversation
      id="bo"
      to="Bo"
      thread={undefined}
      me="ana"
      onRead={null}
      onSend={() => new Promise<boolean>((resolve) => replies.push(resolve))}
    />,
  );
  await page.type('.composer input', 'first unsent canary');
  await page.click('.composer button[type="submit"]');
  await page.type('.composer input', 'second unsent canary');
  await page.click('.composer button[type="submit"]');
  await page.type('.composer input', 'newer draft canary');
  expect(replies).toHaveLength(2);
  await act(async () => replies[0]?.(false));
  expect(page.text()).toContain('first unsent canary');
  await act(async () => replies[1]?.(false));
  const field = page.find('.composer input');
  if (!(field instanceof HTMLInputElement)) throw new Error('composer missing');
  const recoverable = `${field.value}\n${page.text()}`;
  expect(recoverable).toContain('newer draft canary');
  expect(recoverable).toContain('second unsent canary');
  expect(recoverable, 'the second refusal must not erase the first refused message').toContain(
    'first unsent canary',
  );
});
/* eslint-enable no-promise-executor-return, require-await */
