// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Inbox } from '../../apps/web/src/views/inbox.tsx';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { mount, settle } from './mount.tsx';

describe('inbox count when its read is unavailable', () => {
  it('a failed owed-count read cannot silently hide the count beside a waiting item', async () => {
    const item: InboxEntry = {
      id: 'item-1',
      reason: 'assignment',
      workState: 'open',
      access: 'readable',
      owed: true,
      counted: true,
      raisedAt: '2026-09-30T00:00:00.000Z',
      closedAt: null,
      seenAt: null,
      lastDelivery: null,
      subjectRecordId: 'task-1',
      task: { key: 'T-1', title: 'Assigned task' },
      closedBy: null,
    };
    const fetch = ((url: string | URL) =>
      String(url).endsWith('/inbox/count')
        ? Promise.resolve(Response.json({ error: 'temporarily unavailable' }, { status: 503 }))
        : Promise.resolve(Response.json({ ok: true, inbox: [item] }))) as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const view = await mount(<Inbox client={client} grantKey="alpha:reader" />);
    try {
      await settle();
      expect(view.all('[data-inbox-item]')).toHaveLength(1);
      expect(view.text()).toMatch(
        /(?:1 waiting for you|count (?:could not be read|unavailable))/iu,
      );
    } finally {
      await view.unmount();
    }
  });
});
