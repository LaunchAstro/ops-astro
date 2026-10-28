// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, spec #2085): the change-request panel on the review's task, drawn from
// `review.read`'s `changeRequests`. Each phase is drawn in its own words, a pending request
// never as done, the decide controls only for a reader holding `proposal:decide`, no request
// text for a reader the server refused, and the agent's filing waiting on a local model for
// both refusal codes while a person may still file a client pin by hand.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { ChangeRequestPanel } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import { MARKER, dataOf, pin, props, request } from './c57-change-request-fixtures.ts';

describe('C57 change-request panel', () => {
  it('draws each phase in its words, and a pending request is never drawn as done', async () => {
    const view = await mount(
      <ChangeRequestPanel
        {...props({
          load: {
            kind: 'ready',
            pins: [],
            requests: [
              request({ changeRequestId: 'p', state: 'proposed' }),
              request({ changeRequestId: 'w', state: 'approved' }),
              request({ changeRequestId: 'm', state: 'approved', createdTaskId: 'task-made' }),
              request({ changeRequestId: 'r', state: 'refused' }),
            ],
          },
        })}
      />,
    );
    const phase = (id: string) => dataOf(view.find(`[data-change-request="${id}"]`), 'phase');
    expect([phase('p'), phase('w'), phase('m'), phase('r')]).toEqual([
      'proposed',
      'pending',
      'made',
      'refused',
    ]);
    const pending = view.find('[data-change-request="w"]')?.textContent ?? '';
    expect(pending).toContain('Approved, task not made yet');
    expect(pending).not.toContain('made a task');
    expect(view.find('[data-change-request="w"] [data-made-task]')).toBeNull();
    expect(dataOf(view.find('[data-change-request="m"] [data-made-task]'), 'madeTask')).toBe(
      'task-made',
    );
    await view.unmount();
  });

  it('offers approve and refuse only on a proposed request, and none without proposal:decide', async () => {
    const decided: string[] = [];
    const requests = [
      request({ changeRequestId: 'p' }),
      request({ changeRequestId: 'm', state: 'approved', createdTaskId: 't' }),
    ];
    const holder = await mount(
      <ChangeRequestPanel
        {...props({
          load: { kind: 'ready', requests, pins: [] },
          onDecide: (id, decision) => decided.push(`${id}:${decision}`),
        })}
      />,
    );
    expect(holder.all('[data-change-request="p"] [data-decide]')).toHaveLength(2);
    expect(holder.all('[data-change-request="m"] [data-decide]')).toHaveLength(0);
    await holder.click('[data-change-request="p"] [data-decide="refuse"]');
    expect(decided).toEqual(['p:refuse']);
    await holder.unmount();

    const without = await mount(
      <ChangeRequestPanel
        {...props({ canDecide: false, load: { kind: 'ready', requests, pins: [] } })}
      />,
    );
    expect(without.all('[data-decide]')).toHaveLength(0);
    expect(without.text()).toContain(MARKER);
    await without.unmount();
  });

  it('shows a reader the server refused no request text and no controls', async () => {
    const view = await mount(
      <ChangeRequestPanel
        {...props({ load: { kind: 'refused', because: 'NOT_FOUND. Nothing here you can read.' } })}
      />,
    );
    expect(view.text()).not.toContain(MARKER);
    expect(view.all('[data-decide], [data-file-pin]')).toHaveLength(0);
    await view.unmount();
  });

  it('shows the agent path waiting on a local model for both refusal codes, with filing open', async () => {
    for (const agent of ['CLIENT_MODEL_USE_OFF', 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const view = await mount(
        <ChangeRequestPanel
          {...props({
            agent,
            load: {
              kind: 'ready',
              requests: [request({ commentId: 'pin-1' })],
              pins: [
                pin({ commentId: 'pin-1' }),
                pin({ commentId: 'pin-9' }),
                pin({ commentId: 'pin-int', audience: 'internal' }),
              ],
            },
          })}
        />,
      );
      expect(view.find('[data-agent-path]')?.textContent).toContain('waits on a local model');
      // Only the client pin with no request yet is offered for filing.
      expect(view.all('[data-file-pin]').map((form) => dataOf(form, 'filePin'))).toEqual(['pin-9']);
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      await view.unmount();
    }
  });
});
