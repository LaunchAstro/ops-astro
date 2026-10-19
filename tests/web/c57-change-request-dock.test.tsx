// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, spec #2085): the change-request panel on the review's task, drawn from
// `review.read`'s `changeRequests`, and the hook behind it against a stand-in client that
// answers as the server does. Each phase is drawn in its own words, a pending request never as
// done, the decide controls only for a reader holding `proposal:decide`, and no request text
// for a reader the server refused. A decision reads the review again; a retry after no answer
// sends the same operation id; an answer overtaken by a newer read, or from the business the
// panel left, is dropped.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  ChangeRequestDock,
  ChangeRequestPanel,
  type ChangeRequestPanelProps,
} from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import {
  AGENT_WAIT,
  type ChangeRequestView,
  type PinView,
} from '../../apps/web/src/screens/review/change-requests.ts';
import type { DockClient } from '../../apps/web/src/screens/review/use-change-requests.ts';

const MARKER = 'client-words-marker-7f3a';

const request = (over: Partial<ChangeRequestView> = {}): ChangeRequestView => ({
  changeRequestId: 'cr-1',
  commentId: 'pin-1',
  state: 'proposed',
  text: `Move the heading ${MARKER}`,
  createdTaskId: null,
  ...over,
});

const pin = (over: Partial<PinView> = {}): PinView =>
  ({
    commentId: 'pin-9',
    audience: 'client',
    body: 'Can the photo sit lower?',
    anchor: { source: 'rev-1', selector: [] },
    ...over,
  }) as PinView;

const props = (over: Partial<ChangeRequestPanelProps> = {}): ChangeRequestPanelProps => ({
  load: { kind: 'ready', requests: [request()], pins: [] },
  canDecide: true,
  busy: null,
  note: null,
  agent: 'CLIENT_MODEL_USE_OFF',
  onDecide: () => {},
  onFile: () => {},
  onOpenTask: () => {},
  ...over,
});

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
    const phase = (id: string) =>
      view.find(`[data-change-request="${id}"]`)?.getAttribute('data-phase');
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
    expect(view.find('[data-change-request="m"] [data-made-task]')?.getAttribute('data-made-task')).toBe(
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
      <ChangeRequestPanel {...props({ canDecide: false, load: { kind: 'ready', requests, pins: [] } })} />,
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
      expect(view.all('[data-file-pin]').map((form) => form.getAttribute('data-file-pin'))).toEqual(
        ['pin-9'],
      );
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      await view.unmount();
    }
  });
});

/** A stand-in client: each call is held until the test answers it. */
function standIn(businessKey = 'alpha') {
  const calls: {
    name: string;
    body: Readonly<Record<string, unknown>>;
    operationId?: string;
    answer: (value: unknown) => void;
  }[] = [];
  let minted = 0;
  const client: DockClient = {
    businessKey,
    newOperationId: () => `op-${String((minted += 1))}`,
    read: async (name, body) =>
      await new Promise((resolve) => {
        calls.push({ name, body, answer: resolve as (value: unknown) => void });
      }),
    mutate: async (name, body, options) =>
      await new Promise((resolve) => {
        calls.push({
          name,
          body,
          ...(options?.operationId === undefined ? {} : { operationId: options.operationId }),
          answer: resolve as (value: unknown) => void,
        });
      }),
  };
  return { client, calls };
}

const ok = (value: unknown) => ({ ok: true, value });
const refusal = (code: string, fixes: readonly string[] = []) => ({
  refused: true,
  code,
  names: [],
  fixes,
});
const reviewAnswer = (requests: readonly ChangeRequestView[], pins: readonly PinView[] = []) =>
  ok({ ok: true, review: { reviewId: 'rv', changeRequests: requests, pins } });
const holding = (grants: readonly (readonly [string, string])[]) =>
  ok({
    personId: 'p',
    businessKey: 'alpha',
    grants: grants.map(([collection, action]) => ({ collection, action })),
  });

describe('C57 change-request dock hook', () => {
  it('reads the review again after a decision, and hides the controls without proposal:decide', async () => {
    const { client, calls } = standIn();
    const view = await mount(<ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />);
    const settle = async () => {
      await view.render(<ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />);
    };
    calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    calls.find((c) => c.name === 'session.capabilities')?.answer(holding([['proposal', 'decide']]));
    await settle();
    expect(view.all('[data-decide]')).toHaveLength(2);
    await view.click('[data-decide="approve"]');
    const decide = calls.find((c) => c.name === 'review.decide_change');
    expect(decide?.body).toEqual({ changeRequestId: 'cr-1', decision: 'approve' });
    decide?.answer(ok({ recordId: 'cr-1', revision: 1, detail: { state: 'approved' } }));
    await settle();
    const reads = calls.filter((c) => c.name === 'review.read');
    expect(reads).toHaveLength(2);
    reads[1]?.answer(reviewAnswer([request({ state: 'approved' })]));
    await settle();
    expect(view.find('[data-change-request="cr-1"]')?.getAttribute('data-phase')).toBe('pending');
    await view.unmount();

    const other = standIn();
    const member = await mount(
      <ChangeRequestDock client={other.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    other.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    other.calls.find((c) => c.name === 'session.capabilities')?.answer(holding([['proposal', 'write']]));
    await member.render(<ChangeRequestDock client={other.client} reviewId="rv" onOpenTask={() => {}} />);
    expect(member.text()).toContain(MARKER);
    expect(member.all('[data-decide]')).toHaveLength(0);
    await member.unmount();
  });

  it('sends a retry after no answer with the same operation id, and a new intent with a new one', async () => {
    const { client, calls } = standIn();
    const draw = () => <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
    const view = await mount(draw());
    calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    calls.find((c) => c.name === 'session.capabilities')?.answer(holding([['proposal', 'decide']]));
    await view.render(draw());
    await view.click('[data-decide="approve"]');
    calls
      .find((c) => c.name === 'review.decide_change')
      ?.answer({ unavailable: true, because: 'The server did not answer.' });
    await view.render(draw());
    calls.filter((c) => c.name === 'review.read')[1]?.answer(reviewAnswer([request()]));
    await view.render(draw());
    await view.click('[data-decide="approve"]');
    await view.render(draw());
    const decisions = calls.filter((c) => c.name === 'review.decide_change');
    expect(decisions.map((c) => c.operationId)).toEqual(['op-1', 'op-1']);
    decisions[1]?.answer(refusal('CHANGE_REQUEST_ALREADY_DECIDED'));
    await view.render(draw());
    calls.filter((c) => c.name === 'review.read')[2]?.answer(reviewAnswer([request()]));
    await view.render(draw());
    await view.click('[data-decide="refuse"]');
    const third = calls.filter((c) => c.name === 'review.decide_change')[2];
    expect(third?.operationId).not.toBe('op-1');
    await view.unmount();
  });

  it('shows no request text once a refused decision reads back refused, and drops a read overtaken by a newer one', async () => {
    const { client, calls } = standIn();
    const draw = () => <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
    const view = await mount(draw());
    calls.find((c) => c.name === 'session.capabilities')?.answer(holding([['proposal', 'decide']]));
    calls.filter((c) => c.name === 'review.read')[0]?.answer(reviewAnswer([request()]));
    await view.render(draw());
    await view.click('[data-decide="approve"]');
    calls.find((c) => c.name === 'review.decide_change')?.answer(refusal('NOT_FOUND'));
    await view.render(draw());
    const reads = calls.filter((c) => c.name === 'review.read');
    expect(reads).toHaveLength(2);
    reads[1]?.answer(refusal('NOT_FOUND', ['Nothing here you can read.']));
    await view.render(draw());
    expect(view.text()).not.toContain(MARKER);
    expect(view.all('[data-decide]')).toHaveLength(0);
    await view.unmount();

    const raced = standIn();
    const on = (reviewId: string) => (
      <ChangeRequestDock client={raced.client} reviewId={reviewId} onOpenTask={() => {}} />
    );
    const racing = await mount(on('rv-old'));
    raced.calls.find((c) => c.name === 'session.capabilities')?.answer(holding([]));
    await racing.render(on('rv'));
    const [older, newer] = raced.calls.filter((c) => c.name === 'review.read');
    expect([older?.body, newer?.body]).toEqual([{ reviewId: 'rv-old' }, { reviewId: 'rv' }]);
    newer?.answer(reviewAnswer([request({ changeRequestId: 'new', text: 'the newer read' })]));
    await racing.render(on('rv'));
    older?.answer(reviewAnswer([request({ changeRequestId: 'old' })]));
    await racing.render(on('rv'));
    expect(racing.text()).toContain('the newer read');
    expect(racing.text()).not.toContain(MARKER);
    await racing.unmount();
  });

  it('clears what it drew when the business changes, until that business answers', async () => {
    const alpha = standIn('alpha');
    const beta = standIn('beta');
    const view = await mount(
      <ChangeRequestDock client={alpha.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    alpha.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    alpha.calls.find((c) => c.name === 'session.capabilities')?.answer(holding([]));
    await view.render(<ChangeRequestDock client={alpha.client} reviewId="rv" onOpenTask={() => {}} />);
    expect(view.text()).toContain(MARKER);
    await view.render(<ChangeRequestDock client={beta.client} reviewId="rv" onOpenTask={() => {}} />);
    expect(view.text()).not.toContain(MARKER);
    // alpha's late second answer never draws under beta.
    alpha.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    await view.render(<ChangeRequestDock client={beta.client} reviewId="rv" onOpenTask={() => {}} />);
    expect(view.text()).not.toContain(MARKER);
    await view.unmount();
  });

  it('keeps manual filing usable when the filing is refused for a local model', async () => {
    for (const code of ['CLIENT_MODEL_USE_OFF', 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK']) {
      const { client, calls } = standIn();
      const draw = () => <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const view = await mount(draw());
      calls.find((c) => c.name === 'session.capabilities')?.answer(holding([]));
      calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([], [pin()]));
      // eslint-disable-next-line no-await-in-loop
      await view.render(draw());
      // eslint-disable-next-line no-await-in-loop
      await view.type('[data-file-pin="pin-9"] textarea', 'Lower the photo on phones');
      // eslint-disable-next-line no-await-in-loop
      await view.click('[data-file-pin="pin-9"] button');
      const filing = calls.find((c) => c.name === 'review.propose_change');
      expect(filing?.body).toEqual({ commentId: 'pin-9', text: 'Lower the photo on phones' });
      filing?.answer(refusal(code));
      // eslint-disable-next-line no-await-in-loop
      await view.render(draw());
      expect(view.text()).toContain(AGENT_WAIT);
      const button = view.find('[data-file-pin="pin-9"] button') as HTMLButtonElement | null;
      expect(button?.disabled).toBe(false);
      // eslint-disable-next-line no-await-in-loop
      await view.unmount();
    }
  });
});
