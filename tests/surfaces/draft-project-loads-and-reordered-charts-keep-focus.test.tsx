// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { LineChart } from '../../packages/ui/src/kit/chart-line.tsx';
import { DonutChart } from '../../packages/ui/src/kit/chart-radial.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { DraftDetails } from '../../apps/web/src/screens/task/DraftDetails.tsx';
import { emptyDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { focus, resize, standInResizeObserver } from './chart-driver.tsx';
import { mount } from './mount.tsx';

standInResizeObserver();

it('the visible fresh-draft Project control loads its projects', async () => {
  const reads: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    // eslint-disable-next-line require-await -- a fetch stand-in answers as a promise
    fetch: async (input) => {
      reads.push(String(input));
      return Response.json({
        ok: true,
        tasks: [{ id: 'project-1', title: 'Delivery', clientSet: false, client: null }],
      });
    },
  });
  const view = await mount(
    <DraftDetails client={client} draft={emptyDraft(null)} put={() => {}} locked={false} />,
  );
  expect(reads).toEqual([]);
  const button = view.find('#panel-draft-board-control');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Expected Project control');
  await act(() => button.focus());
  await view.click('#panel-draft-board-control');
  expect(reads).toEqual(['/api/b/alpha/task/board']);
  expect(view.all('[role=option]').map((option) => option.textContent)).toEqual([
    'None',
    'Delivery',
  ]);
});

it('a reordered line chart keeps its tab stop on the focused point', async () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- each case draws its own chart
  const chart = (labels: string[]) => (
    <LineChart
      name="Replies"
      labels={labels}
      series={[{ label: 'Replies', values: labels.map((label) => (label === 'Tue' ? 55 : 10)) }]}
    />
  );
  const view = await mount(chart(['Mon', 'Tue']));
  await resize(600);
  const tue = view.all('.chart__hit')[1];
  await focus(tue);
  await view.render(chart(['Tue', 'Mon']));
  expect(document.activeElement).toBe(tue);
  expect(view.all('.chart__hit').map((point) => point.getAttribute('tabindex'))).toEqual([
    '0',
    '-1',
  ]);
  expect(view.find('[role=tooltip]')?.textContent).toBe('TueReplies 55');
});

it('a reordered donut keeps its tab stop on the focused slice', async () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- each case draws its own chart
  const chart = (labels: string[]) => (
    <DonutChart
      name="Spend"
      centre="65"
      centreLabel="Total"
      slices={labels.map((label) => ({ label, value: label === 'Tue' ? 55 : 10 }))}
    />
  );
  const view = await mount(chart(['Mon', 'Tue']));
  const tue = view.all('.chart__slice')[1];
  await focus(tue);
  await view.render(chart(['Tue', 'Mon']));
  expect(document.activeElement).toBe(tue);
  expect(view.all('.chart__slice').map((point) => point.getAttribute('tabindex'))).toEqual([
    '0',
    '-1',
  ]);
  expect(view.find('[role=tooltip]')?.textContent).toContain('TueValue 55');
});
