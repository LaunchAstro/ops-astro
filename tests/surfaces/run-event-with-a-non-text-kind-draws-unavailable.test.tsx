// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { answer, event, open, run, tick } from './t2g-run-progress-fixture.tsx';

it('an event with a non-string kind draws unavailable', async () => {
  const page = await open(
    answer(
      'ready',
      [run('r-1', 'running')],
      [{ ...event(1, 'r-1', 'claimed'), kind: { malformed: true } }],
    ),
  );
  try {
    await tick();
    expect(page.find('[data-run="unavailable"]')?.textContent).toContain(
      'The run could not be read.',
    );
    expect(page.all('[data-run-id]')).toHaveLength(0);
  } finally {
    await page.unmount();
  }
});
