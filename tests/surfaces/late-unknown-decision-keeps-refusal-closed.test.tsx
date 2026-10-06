// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable unicorn/consistent-function-scoping -- the review proof, kept as written */

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { refused, taskPage, taskServer, tick } from './task-page-fixture.tsx';

it('a late unknown decision result cannot reopen a held authority refusal', async () => {
  const client = taskServer(
    { state: 'pending', expired: false },
    { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
  );
  type Result = Awaited<ReturnType<typeof client.mutate>>;
  let finish: (result: Result) => void = () => {};
  const pending = new Promise<Result>((resolve) => {
    finish = resolve;
  });
  const writes = vi.spyOn(client, 'mutate').mockReturnValueOnce(pending);
  const page = await taskPage(client);
  try {
    await page.click('#perspective-tab-agent');
    // Each view owns its own busy state, so both decisions can be in flight.
    await page.click('[data-decide="approve"]');
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
    expect(page.find('[data-decide="approve"]')).toBeNull();

    // The earlier request lost its response. It conveys no restored authority.
    await act(async () => {
      finish({ unavailable: true, because: 'The earlier decision response was lost.' });
      await pending;
    });
    await tick();
    expect(
      page.find('[data-agent="gate-actions"] [data-gate="closed"]'),
      'an unknown result must preserve the SCOPE_NOT_GRANTED closure already held by both views',
    ).not.toBeNull();
    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-agent="reject"]')?.hasAttribute('disabled')).toBe(true);
  } finally {
    await page.unmount();
  }
});
