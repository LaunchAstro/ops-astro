// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access sends one write at a time and reads the list again after
// one lands. Raced here on Revoke delegation: two tabs revoking at once,
// answered in both orders; the answer lost before and after the server stored
// it, and after the screen left; and the retry, which must reuse the operation
// id while the outcome is unknown and mint a new one after a refusal.

import { afterEach, describe, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import {
  BOTH_ORDERS,
  idOf,
  raceServer,
  refused,
  releaseHeld,
  stored,
} from '../web/write-race-support.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { ADA, AGENT, MIA, access } from './access-screen-world.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one screen at a time, as React's act needs
    await view.unmount();
  }
});

function world() {
  const record = { revoked: false, refuse: false, reads: 0 };
  const api = raceServer((path) => {
    if (path === '/access/read') {
      record.reads += 1;
      return { status: 200, body: access([ADA, MIA], record.revoked ? [] : [AGENT]) };
    }
    if (record.revoked || record.refuse) return refused('NOT_FOUND', 404);
    record.revoked = true;
    return stored(1);
  });
  return { record, ...api };
}

type World = ReturnType<typeof world>;

async function screen(api: World): Promise<Mounted> {
  const view = await mount(<AccessScreen client={api.client} grantKey="alpha:ada:0" />);
  live.push(view);
  await settle();
  await settle();
  return view;
}

async function revoke(view: Mounted): Promise<void> {
  await view.click('[data-revoke="d-1"] button');
  await settle();
  await settle();
}

const outcome = (view: Mounted): string | undefined =>
  view.find('[data-access-outcome]')?.textContent ?? undefined;

describe('two tabs revoking one delegation at once', () => {
  it.each(BOTH_ORDERS)('answered %s, each tab shows its own answer', async (_, x, y) => {
    const api = world();
    const a = await screen(api);
    const b = await screen(api);
    api.fates.push('hold', 'hold');
    await revoke(a);
    await revoke(b);
    await releaseHeld(api.held, x);
    await releaseHeld(api.held, y);
    expect(api.sent).toHaveLength(2);
    expect(outcome(a)).toContain('Revoked the delegation');
    expect(outcome(b)).toContain('NOT_FOUND');
  });
});

describe('a revoke whose answer is lost', () => {
  it('before it reached the server: the failure is shown and Revoke sends again', async () => {
    const api = world();
    const view = await screen(api);
    api.fates.push('unreachable');
    await revoke(view);
    expect(api.sent).toHaveLength(0);
    expect(view.find('[data-access-outcome="refused"]')).not.toBeNull();
    await revoke(view);
    expect(api.sent).toHaveLength(1);
    expect(outcome(view)).toContain('Revoked the delegation');
  });

  it('after the server stored it: the failure is shown and the list is not redrawn as changed', async () => {
    const api = world();
    const view = await screen(api);
    api.fates.push('lose');
    await revoke(view);
    expect(api.record.revoked).toBe(true);
    expect(view.find('[data-access-outcome="refused"]')).not.toBeNull();
    expect(view.find('[data-revoke="d-1"] button')).not.toBeNull();
    expect(api.record.reads).toBe(1);
  });

  it('answered after the screen left: nothing more is sent or read', async () => {
    const api = world();
    const view = await screen(api);
    api.fates.push('hold');
    await revoke(view);
    await view.unmount();
    await releaseHeld(api.held, 0);
    await settle();
    expect(api.sent).toHaveLength(1);
    expect(api.record.reads).toBe(1);
  });
});

describe('a revoke pressed again', () => {
  it('after a refusal is a new operation', async () => {
    const api = world();
    api.record.refuse = true;
    const view = await screen(api);
    await revoke(view);
    expect(outcome(view)).toContain('NOT_FOUND');
    await revoke(view);
    expect(api.sent).toHaveLength(2);
    expect(idOf(api.sent, 1)).not.toBe(idOf(api.sent, 0));
  });
});
