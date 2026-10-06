// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the owner check reads the attribute the markup writes */
//
// C52-A, Settings ▸ Workflow triggers: each activation shows the standing
// approval it names, and a person adopts a newer version, rolls back, revokes
// the approval and turns the automation off, rollback and revocation as two
// controls. The server is a stub that keeps what it was sent, so each case
// proves the control goes through its own command at the revision the
// registry showed, and a reload shows the change. A press whose answer was
// lost is sent again as the same attempt; a late answer for a business the
// panel no longer shows is dropped, and with it that business's refusal.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TriggersPanel } from '../../apps/web/src/screens/settings/triggers.tsx';
import { mount } from './mount.tsx';
import { bodiesOf, clientOf, json, server } from './c52a-approvals-stub.ts';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const ROW = '[data-activation="a-1"]';

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('C52-A standing approvals on the Workflow triggers panel', () => {
  it('C52-A owner check: turning an automation off goes through activation.turn_off at the shown revision, and a reload shows it off, offering no approval', async () => {
    const stub = server();
    const client = clientOf(stub.fetch);
    const page = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(page.find(`${ROW}`)?.getAttribute('data-enabled')).toBe('true');
    await page.click(`${ROW} [data-control="turn-off"]`);
    await tick();
    expect(bodiesOf(stub, '/activation/turn_off')).toMatchObject([
      { activationId: 'a-1', expectedRevision: 3 },
    ]);
    await page.unmount();
    const again = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(again.find(`${ROW}`)?.getAttribute('data-enabled')).toBe('false');
    // Only an automation that is on is approved (C52-A): no adopt or roll back while off.
    for (const control of ['turn-off', 'adopt', 'roll-back']) {
      expect(again.find(`${ROW} [data-control="${control}"]`), control).toBeNull();
    }
    expect(again.find(`${ROW} [data-trigger="approval"]`)?.textContent).toBe('not approved to run');
    await again.unmount();
  });

  it('C52-A an automation turned off after an adoption offers no roll back', async () => {
    const stub = server();
    const client = clientOf(stub.fetch);
    const page = await mount(<TriggersPanel client={client} />);
    await tick();
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    await page.click(`${ROW} [data-control="turn-off"]`);
    await tick();
    await page.unmount();
    const again = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(again.find(`${ROW}`)?.getAttribute('data-enabled')).toBe('false');
    expect(again.find(`${ROW} [data-control="roll-back"]`)).toBeNull();
    await again.unmount();
  });

  it('C52-A adopt, roll back and revoke: each its own control and command, at the shown revision, and the chip says the approval', async () => {
    const stub = server();
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    const chip = (): Element | null | undefined =>
      page.find(`${ROW} [data-trigger="approval"]`)?.closest('.chip');
    const version = (): string | null | undefined =>
      page.find(`${ROW} [data-trigger="version"]`)?.textContent;
    expect([chip()?.textContent, chip()?.className]).toStrictEqual([
      'not approved to run',
      'chip chip--soft is-idle',
    ]);
    expect(page.find(`${ROW} [data-control="roll-back"]`)).toBeNull();
    expect(page.find(`${ROW} [data-control="revoke"]`)).toBeNull();

    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(bodiesOf(stub, '/activation/adopt').at(-1)).toMatchObject({
      activationId: 'a-1',
      versionId: 'v-2',
      expectedRevision: 3,
    });
    expect(version()).toContain('v2');
    expect([chip()?.textContent, chip()?.className]).toStrictEqual([
      'approved to run',
      'chip chip--soft is-ok',
    ]);
    expect(page.find(`${ROW} [data-control="adopt"]`)).toBeNull();

    await page.click(`${ROW} [data-control="revoke"]`);
    await tick();
    expect(bodiesOf(stub, '/approval/revoke').at(-1)).toMatchObject({ approvalId: 's-3' });
    expect([chip()?.textContent, chip()?.className]).toStrictEqual([
      'approval revoked',
      'chip chip--soft is-warn',
    ]);
    expect(version()).toContain('v2');
    expect(page.find(`${ROW} [data-control="revoke"]`)).toBeNull();

    await page.click(`${ROW} [data-control="roll-back"]`);
    await tick();
    expect(bodiesOf(stub, '/activation/roll_back').at(-1)).toMatchObject({
      activationId: 'a-1',
      expectedRevision: 4,
    });
    expect(version()).toContain('v1');
    expect(chip()?.textContent).toBe('rolled back, approved to run');
    await page.unmount();
  });

  it('C52-A an adoption whose answer was lost is sent again as the same attempt, and a new press is a new one', async () => {
    const stub = server({ lose: 1 });
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(page.find('[data-settings="triggers-refusal"]')?.textContent).toContain('dropped');
    expect(page.find(`${ROW} [data-trigger="version"]`)?.textContent).toContain('v1');
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    await page.click(`${ROW} [data-control="turn-off"]`);
    await tick();
    const [lost, resent] = bodiesOf(stub, '/activation/adopt');
    expect(typeof lost?.['operationId']).toBe('string');
    expect(resent?.['operationId']).toBe(lost?.['operationId']);
    const [off] = bodiesOf(stub, '/activation/turn_off');
    expect(off?.['operationId']).not.toBe(lost?.['operationId']);
    expect(off?.['expectedRevision']).toBe(4);
    await page.unmount();
  });

  it('C52-A a refused change is shown as it came and changes nothing on screen', async () => {
    const stub = server({ refuse: '/activation/adopt' });
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(page.find('[data-settings="triggers-refusal"]')?.textContent).toBe(
      'VERSION_STALE: revision=9',
    );
    expect(page.find(`${ROW} [data-trigger="version"]`)?.textContent).toContain('v1');
    await page.unmount();
  });

  it('C52-A a caller refused the registry is shown the refusal and no rows', async () => {
    const page = await mount(
      <TriggersPanel client={clientOf(server({ refuse: 'registry' }).fetch)} />,
    );
    await tick();
    expect(page.text()).toContain('not permitted');
    expect(page.find('[data-activation]')).toBeNull();
    expect(page.find('[data-control]')).toBeNull();
    await page.unmount();
  });

  it('C52-A after a change, every control waits for the reload that shows its effect', async () => {
    const stub = server();
    const held: (() => void)[] = [];
    let holding = false;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      if (holding && String(url).endsWith('/automation/registry')) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      }
      return await stub.fetch(url, init);
    }) as typeof globalThis.fetch;
    const page = await mount(<TriggersPanel client={clientOf(fetch)} />);
    await tick();
    // Version 2 adopted and shown: approval s-3 stands, with its revoke control.
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    holding = true;
    await page.click(`${ROW} [data-control="roll-back"]`);
    await tick();
    // The rollback is answered (approval s-4); the row on screen still shows s-3.
    expect(held).toHaveLength(1);
    for (const control of ['revoke', 'turn-off', 'roll-back']) {
      expect(
        page.find(`${ROW} [data-control="${control}"]`)?.hasAttribute('disabled'),
        control,
      ).toBe(true);
    }
    holding = false;
    await act(async () => {
      held[0]?.();
      await Promise.resolve();
    });
    await tick();
    await page.click(`${ROW} [data-control="revoke"]`);
    await tick();
    // The revocation names the approval the reload showed, never the replaced one.
    expect(bodiesOf(stub, '/approval/revoke')).toStrictEqual([
      expect.objectContaining({ approvalId: 's-4' }),
    ]);
    await page.unmount();
  });

  it('C52-A a business switch drops the last business refusal, its late change answer and its rows', async () => {
    const held: ((response: Response) => void)[] = [];
    const alpha = server({ refuse: '/activation/turn_off', name: 'Alpha only' });
    // Alpha's registry answers; its adoption is held until bravo is on screen.
    const slow = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/activation/adopt')) {
        return await new Promise<Response>((resolve) => {
          held.push(resolve);
        });
      }
      return await alpha.fetch(url, init);
    }) as typeof globalThis.fetch;
    const page = await mount(<TriggersPanel client={clientOf(slow)} />);
    await tick();
    await page.click(`${ROW} [data-control="turn-off"]`);
    await tick();
    expect(page.find('[data-settings="triggers-refusal"]')?.textContent).toContain('VERSION_STALE');
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(held).toHaveLength(1);
    expect(page.find(`${ROW} [data-control="adopt"]`)?.hasAttribute('disabled')).toBe(true);
    const bravo = server({ name: 'Bravo digest' });
    await page.render(<TriggersPanel client={clientOf(bravo.fetch, 'bravo')} />);
    await tick();
    await act(async () => {
      held[0]?.(json({ refused: true, code: 'VERSION_STALE', names: ['alpha'], fixes: [] }, 409));
      await Promise.resolve();
    });
    await tick();
    expect(page.text()).not.toContain('Alpha only');
    expect(page.text()).toContain('Bravo digest');
    expect(page.find('[data-settings="triggers-refusal"]')).toBeNull();
    // Bravo's controls are live: alpha's unanswered press does not hold them.
    expect(page.find(`${ROW} [data-control="adopt"]`)?.hasAttribute('disabled')).toBe(false);
    expect(bodiesOf(bravo, '/automation/registry')).toHaveLength(1);
    await page.unmount();
  });
});
