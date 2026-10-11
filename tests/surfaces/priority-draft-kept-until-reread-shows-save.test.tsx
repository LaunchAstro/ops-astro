// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';
import { fourEyesWorld, tick } from './settings-four-eyes-world.tsx';
import { choosePriority, priorityInput, prioritySave } from './priority-settings-world.tsx';

function world() {
  const legacy = fourEyesWorld({ value: 500, revision: 7 });
  const state: {
    value: string[];
    revision: number;
    reread: 'ready' | 'waiting' | 'failed';
    release: () => void;
    writes: Record<string, unknown>[];
    reads: number;
  } = {
    value: ['trust'],
    revision: 7,
    reread: 'ready',
    release: () => {},
    writes: [],
    reads: 0,
  };
  const read = () =>
    Response.json({
      ok: true,
      settings: [
        {
          key: 'priority_stages',
          value: state.value,
          valueType: 'stage_ids',
          revision: state.revision,
          updatedAt: '2026-10-11T00:00:00.000Z',
          updatedByActorId: 'synthetic-admin',
        },
      ],
    });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const at = input instanceof Request ? input.url : String(input);
    if (at.endsWith('/settings/read')) {
      state.reads += 1;
      if (state.reread === 'failed') return new Response(null, { status: 503 });
      if (state.reread === 'waiting')
        return await new Promise<Response>((resolve) => {
          state.release = () => resolve(read());
        });
      return read();
    }
    if (at.endsWith('/settings/set_priority_stages')) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      state.writes.push(body);
      const value = body['value'];
      if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
        throw new Error('Proof received invalid priority stages');
      }
      state.value = value;
      state.revision += 1;
      return Response.json({
        recordId: 'priority',
        revision: state.revision,
        detail: { value: state.value, revision: state.revision },
      });
    }
    return await legacy.fetch(input, init);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    state,
    screen: <SettingsScreen client={client} grantKey="alpha:ada:0" storage={null} />,
  };
}

it('an edit during the confirmed-save reread retains the saved Sales stage', async () => {
  const { state, screen } = world();
  const page = await mount(screen);
  try {
    await tick();
    await choosePriority(page, 'sales');
    state.reread = 'waiting';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(state.value).toEqual(['trust', 'sales']);
    expect(state.reads).toBe(2);
    if (!prioritySave(page).disabled) await choosePriority(page, 'retention');
    state.reread = 'ready';
    state.release();
    await tick();
    // If controls were held during the reread, the person can edit now.
    if (!priorityInput(page, 'retention').checked) await choosePriority(page, 'retention');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(state.writes[1]).toMatchObject({
      value: ['trust', 'sales', 'retention'],
      expectedRevision: 8,
    });
  } finally {
    state.release();
    await page.unmount();
  }
});

it('a failed confirmed-save reread cannot turn the next Save into clearing priority', async () => {
  const { state, screen } = world();
  const page = await mount(screen);
  try {
    await tick();
    await choosePriority(page, 'sales');
    state.reread = 'failed';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(state.value).toEqual(['trust', 'sales']);
    expect(state.reads).toBe(2);
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(state.value).toEqual(['trust', 'sales']);
  } finally {
    await page.unmount();
  }
});
