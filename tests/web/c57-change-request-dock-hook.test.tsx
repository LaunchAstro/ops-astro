// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, spec #2085): the change-request panel's hook against a stand-in client
// that answers as the server does. A decision reads the review again; a retry after no answer
// sends the same operation id and a new intent a new one; an answer overtaken by a newer read,
// or from the business the panel left, is dropped; a refused decision whose read back is
// refused leaves no request text; and filing stays usable when it waits on a local model.

import { describe, expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { ChangeRequestDock } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import { AGENT_WAIT } from '../../apps/web/src/screens/review/change-requests.ts';
import {
  MARKER,
  holding,
  ok,
  pin,
  refusal,
  request,
  reviewAnswer,
  standIn,
  dataOf,
} from './c57-change-request-fixtures.ts';

describe('C57 change-request dock hook', () => {
  it('reads the review again after a decision, and hides the controls without proposal:decide', async () => {
    const { client, calls } = standIn();
    const view = await mount(
      <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />,
    );
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
    expect(dataOf(view.find('[data-change-request="cr-1"]'), 'phase')).toBe('pending');
    await view.unmount();

    const other = standIn();
    const member = await mount(
      <ChangeRequestDock client={other.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    other.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    other.calls
      .find((c) => c.name === 'session.capabilities')
      ?.answer(holding([['proposal', 'write']]));
    await member.render(
      <ChangeRequestDock client={other.client} reviewId="rv" onOpenTask={() => {}} />,
    );
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
    calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
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

  it('draws the newest read when two reads after decisions on one review answer out of order', async () => {
    const { client, calls } = standIn();
    const draw = () => <ChangeRequestDock client={client} reviewId="rv" onOpenTask={() => {}} />;
    const view = await mount(draw());
    const two = [request({ changeRequestId: 'a' }), request({ changeRequestId: 'b' })];
    calls.find((c) => c.name === 'session.capabilities')?.answer(holding([['proposal', 'decide']]));
    calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer(two));
    await view.render(draw());
    const approve = async (id: string) => {
      await view.click(`[data-change-request="${id}"] [data-decide="approve"]`);
      calls
        .findLast((c) => c.name === 'review.decide_change')
        ?.answer(ok({ recordId: id, revision: 1 }));
      await view.render(draw());
    };
    await approve('a');
    await approve('b');
    const [, older, newer] = calls.filter((c) => c.name === 'review.read');
    newer?.answer(
      reviewAnswer([
        request({ changeRequestId: 'a', state: 'approved' }),
        request({ changeRequestId: 'b', state: 'approved' }),
      ]),
    );
    await view.render(draw());
    older?.answer(reviewAnswer([request({ changeRequestId: 'a', state: 'approved' }), two[1]!]));
    await view.render(draw());
    expect(dataOf(view.find('[data-change-request="b"]'), 'phase')).toBe('pending');
    await view.unmount();
  });

  it('clears what it drew when the business changes, until that business answers', async () => {
    const alpha = standIn('alpha');
    const beta = standIn('beta');
    const view = await mount(
      <ChangeRequestDock client={alpha.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    alpha.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    alpha.calls.find((c) => c.name === 'session.capabilities')?.answer(holding([]));
    await view.render(
      <ChangeRequestDock client={alpha.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    expect(view.text()).toContain(MARKER);
    await view.render(
      <ChangeRequestDock client={beta.client} reviewId="rv" onOpenTask={() => {}} />,
    );
    expect(view.text()).not.toContain(MARKER);
    // alpha's late second answer never draws under beta.
    alpha.calls.find((c) => c.name === 'review.read')?.answer(reviewAnswer([request()]));
    await view.render(
      <ChangeRequestDock client={beta.client} reviewId="rv" onOpenTask={() => {}} />,
    );
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
