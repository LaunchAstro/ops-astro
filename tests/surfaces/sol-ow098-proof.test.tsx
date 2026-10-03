// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable require-await, unicorn/consistent-function-scoping, unicorn/prefer-dom-node-dataset -- Sol's proof, kept as written */

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AllowanceLine } from '../../apps/web/src/views/allowance-line.tsx';
import {
  PageFreshnessProvider,
  StripFreshness,
  useFreshOnPage,
} from '../../apps/web/src/views/freshness.tsx';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, type LiveHub } from '../../apps/web/src/data/live.ts';
import { mount, settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

function gate() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

function network(answer: (path: string, body: Record<string, unknown>) => Promise<Response>) {
  const fetch: typeof globalThis.fetch = async (input, init) =>
    await answer(String(input), JSON.parse(String(init?.body ?? '{}')));
  return new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
}

it('Sol proof, criterion correctness: switching conversations clears the previous conversation allowance while reading', async () => {
  const pending = gate();
  const client = network(async (_path, body) => {
    if (body['conversationId'] === 'second') await pending.held;
    return Response.json({
      ok: true,
      allowance: {
        set: true,
        currency: 'AUD',
        limitMinor: 5000,
        leftMinor: 3000,
        conversation: { spentMinor: body['conversationId'] === 'first' ? 1234 : 0, heldMinor: 0 },
      },
    });
  });
  const page = track(
    await mount(<AllowanceLine client={client} conversationId="first" settled={0} />),
  );
  await settle();
  expect(page.text()).toContain('AUD 12.34 spent');
  await page.render(<AllowanceLine client={client} conversationId="second" settled={0} />);
  const duringRead = page.text();
  pending.release();
  await settle();
  expect(page.text()).toContain('AUD 0.00 spent');
  expect(
    duringRead,
    "the new tab must not call the old tab's spend This conversation",
  ).not.toContain('AUD 12.34 spent');
});

function ReadPage(props: { client: OperationsClient; recordId: string; hub: LiveHub }) {
  const { state } = useRead<unknown>({
    grantKey: 'alpha:person',
    run: () => props.client.read('task.read', { recordId: props.recordId }),
    deps: [props.recordId],
  });
  useFreshOnPage(state, props.hub);
  return <span data-read={state.outcome} />;
}

it('Sol proof, criterion correctness: an unread task claims no freshness after navigating from a read task', async () => {
  const pending = gate();
  const client = network(async (_path, body) => {
    if (body['recordId'] === 'second') await pending.held;
    return Response.json({ task: { id: body['recordId'] } });
  });
  const hub = createLiveHub(async () => null);
  const draw = (recordId: string) => (
    <PageFreshnessProvider>
      <StripFreshness />
      <ReadPage client={client} recordId={recordId} hub={hub} />
    </PageFreshnessProvider>
  );
  const page = track(await mount(draw('first')));
  await settle();
  expect(page.find('.fresh--live')).not.toBeNull();
  await page.render(draw('second'));
  expect(page.find('[data-read]')?.getAttribute('data-read')).toBe('loading');
  const whileUnread = page.find('.freshrow');
  pending.release();
  await settle();
  expect(page.find('.fresh--live')).not.toBeNull();
  expect(
    whileUnread,
    'no read of this task has succeeded, so no marker can describe it',
  ).toBeNull();
});
