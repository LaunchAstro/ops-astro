// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { useLayoutEffect, useRef } from 'react';
import { expect, it } from 'vitest';
import { drawScreen } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';

const CANARY = 'Alpha private conversation title';
const match = matchRoute('/agent/conversation-one');
if (match?.id !== 'agency:agent-conversation') throw new Error('Conversation route missing');
const route = match;

function ObservedScreen(props: {
  readonly client: OperationsClient;
  readonly committed: string[];
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (props.client.businessKey === 'bravo') props.committed.push(root.current?.textContent ?? '');
  }, [props.client, props.committed]);
  return (
    <div ref={root}>
      {drawScreen(route, {
        client: props.client,
        grantKey: props.client.businessKey,
        notice: null,
        storage: null,
        navigate: () => {},
      })}
    </div>
  );
}

// Sol OW-083.1 criterion 2, retitled by what it proves; its body is Sol's.
it('business to business, a new grant never commits the old conversation into its DOM', async () => {
  const alpha = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      Promise.resolve(
        json({ conversation: { title: CANARY, subject: 'Private' }, messages: [], wrapUp: null }),
      ),
  });
  const bravo = new OperationsClient({
    origin: '',
    businessKey: 'bravo',
    signedIn: true,
    fetch: () =>
      Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404)),
  });
  const committed: string[] = [];
  const page = await mount(<ObservedScreen client={alpha} committed={committed} />);
  try {
    await settle();
    expect(page.text(), 'the authorised Alpha read really drew the private title').toContain(
      CANARY,
    );
    await page.render(<ObservedScreen client={bravo} committed={committed} />);
    await settle();
    expect(page.text(), 'Bravo is eventually refused').not.toContain(CANARY);
    expect(committed.length, 'the new grant committed a screen').toBeGreaterThan(0);
    expect(
      committed.join('\n'),
      'a passive effect is too late to remove another business from the committed DOM',
    ).not.toContain(CANARY);
  } finally {
    await page.unmount();
  }
});
