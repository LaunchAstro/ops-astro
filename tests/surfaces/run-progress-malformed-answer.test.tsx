// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { mount } from './mount.tsx';

it('a malformed successful run answer becomes unavailable without an unhandled rejection', async () => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () => Promise.resolve(Response.json(null)),
    newOperationId: () => 'operation-1',
  });
  const screen = await mount(
    <RunProgress client={client} grantKey="alpha:person" taskKey="task-1" readOf={null} />,
  );
  try {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(screen.host.querySelector<HTMLElement>('[data-run-progress]')?.dataset.outcome).toBe(
      'unavailable',
    );
  } finally {
    await screen.unmount();
  }
});
