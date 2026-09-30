// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10: the Ad hoc and Client access ticks (DP-16, DP-17), the live ones
// the dock task panel carries (the task page's are inert, MP-4-2). Each turns
// on and off by pointer and by keyboard, in place, through the command that
// owns it: `task.set_adhoc`, and `task.share_with_client` or
// `task.revoke_client_share`. The tick draws what the server says after the
// reread, never a guess of its own.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { HandlingTicks } from '../../apps/web/src/screens/task/Ticks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records each command sent; answers each with `answer`, or holds it until released. */
function commands(answer: () => { body: unknown; status: number } | 'hold') {
  const sent: Sent[] = [];
  const held: (() => void)[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ command, body });
    const reply = answer();
    if (reply !== 'hold') return Promise.resolve(json(reply.body, reply.status));
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(json({ ok: true, recordId: TASK_ID, revision: 5 }));
      });
    });
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, held };
}

const OK = () => ({ body: { ok: true, recordId: TASK_ID, revision: 5 }, status: 200 });

interface Flags {
  adHoc: boolean;
  clientAccess: boolean;
}

/** The ticks under a parent that rereads on change: the flags it redraws are the server's. */
async function ticks(client: OperationsClient, flags: Flags, server: Flags) {
  let view: Mounted | undefined;
  let rereads = 0;
  const draw = (now: Flags) => (
    <HandlingTicks
      client={client}
      task={{ id: TASK_ID, revision: 4, ...now }}
      onChanged={() => {
        rereads += 1;
        void view?.render(draw({ ...server }));
      }}
    />
  );
  view = await mount(draw(flags));
  return { view, rereads: () => rereads };
}

const key = async (view: Mounted, selector: string, name: string) => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    await Promise.resolve();
  });
};

const checked = (view: Mounted, name: string) =>
  view.find(`[data-tick="${name}"]`)?.getAttribute('aria-checked');

describe('MP-4-10 ticks toggle: pointer', () => {
  it('Ad hoc turns on and off by pointer, through task.set_adhoc at the task’s revision', async () => {
    const { client, sent } = commands(OK);
    const server = { adHoc: true, clientAccess: false };
    const { view } = await ticks(client, { adHoc: false, clientAccess: false }, server);
    const node = view.find('[data-tick="adhoc"]');
    await view.click('[data-tick="adhoc"]');
    await tick();
    expect(sent[0]).toStrictEqual({
      command: 'task.set_adhoc',
      body: expect.objectContaining({
        recordId: TASK_ID,
        expectedRevision: 4,
        fields: { ad_hoc: true },
      }) as unknown,
    });
    expect(checked(view, 'adhoc')).toBe('true');
    // In place: the same control, still on this page.
    expect(view.find('[data-tick="adhoc"]')).toBe(node);
    server.adHoc = false;
    await view.click('[data-tick="adhoc"]');
    await tick();
    expect(sent[1]?.body['fields']).toStrictEqual({ ad_hoc: false });
    await view.unmount();
  });
});

describe('MP-4-10 ticks toggle: keyboard', () => {
  it('Client access turns on by Space and off by Enter, sharing then withdrawing', async () => {
    const { client, sent } = commands(OK);
    const server = { adHoc: false, clientAccess: true };
    const { view } = await ticks(client, { adHoc: false, clientAccess: false }, server);
    await key(view, '[data-tick="client-access"]', ' ');
    await tick();
    expect(sent.map((one) => one.command)).toStrictEqual(['task.share_with_client']);
    expect(checked(view, 'client-access')).toBe('true');
    server.clientAccess = false;
    await key(view, '[data-tick="client-access"]', 'Enter');
    await tick();
    expect(sent.map((one) => one.command)).toStrictEqual([
      'task.share_with_client',
      'task.revoke_client_share',
    ]);
    expect(checked(view, 'client-access')).toBe('false');
    await view.unmount();
  });

  it('each tick is a keyboard stop with the checkbox role, and other keys do nothing', async () => {
    const { client, sent } = commands(OK);
    const { view } = await ticks(
      client,
      { adHoc: false, clientAccess: false },
      { adHoc: false, clientAccess: false },
    );
    for (const name of ['adhoc', 'client-access']) {
      const node = view.find(`[data-tick="${name}"]`);
      expect(node?.getAttribute('role')).toBe('checkbox');
      expect(node?.getAttribute('tabindex')).toBe('0');
    }
    await key(view, '[data-tick="adhoc"]', 'a');
    await tick();
    expect(sent).toHaveLength(0);
    await view.unmount();
  });
});

describe('MP-4-10 ticks toggle: one press at a time, and a refusal said', () => {
  it('a second press while the first is in flight sends nothing', async () => {
    const { client, sent, held } = commands(() => 'hold');
    const { view } = await ticks(
      client,
      { adHoc: false, clientAccess: false },
      { adHoc: true, clientAccess: false },
    );
    await view.click('[data-tick="adhoc"]');
    await view.click('[data-tick="adhoc"]');
    await key(view, '[data-tick="client-access"]', ' ');
    expect(sent).toHaveLength(1);
    expect(view.find('[data-tick="adhoc"]')?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      for (const release of held) release();
      await Promise.resolve();
    });
    await tick();
    expect(checked(view, 'adhoc')).toBe('true');
    await view.unmount();
  });

  it('a refusal is said, and the tick stays as the server has it', async () => {
    const { client } = commands(() => ({
      body: { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['access'], fixes: [] },
      status: 403,
    }));
    const { view, rereads } = await ticks(
      client,
      { adHoc: false, clientAccess: false },
      { adHoc: false, clientAccess: false },
    );
    await view.click('[data-tick="client-access"]');
    await tick();
    expect(view.find('[role="alert"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(checked(view, 'client-access')).toBe('false');
    expect(rereads()).toBe(0);
    await view.unmount();
  });
});
