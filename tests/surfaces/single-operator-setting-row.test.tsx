// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1781: the Settings row for single-operator mode. It draws the business's
// `single_operator_mode` row as `settings.read` answers it, switches it
// through `settings.set_single_operator` and no other command, with the
// revision the read carried, and opens only under `settings:manage`. The
// server's `SINGLE_OPERATOR_REFUSED` (a second operator exists) is said in a
// plain sentence, never as its code.

import { afterEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';
import { fourEyesWorld, tick } from './settings-four-eyes-world.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  value: boolean;
  revision: number;
  manage: boolean;
  /** The server's answer to the next switch: written, or refused with a second operator. */
  next: 'ok' | 'second-operator';
  readonly writes: Record<string, unknown>[];
  readonly at: string[];
}

function world(start: Partial<World> = {}) {
  const legacy = fourEyesWorld({ value: 500, revision: 7 });
  const state: World = {
    value: false,
    revision: 3,
    manage: true,
    next: 'ok',
    writes: [],
    at: [],
    ...start,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const at = input instanceof Request ? input.url : String(input);
    state.at.push(at);
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: 'alpha',
        grants: state.manage ? [{ collection: 'settings', action: 'manage' }] : [],
      });
    }
    if (at.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [
          {
            key: 'single_operator_mode',
            value: state.value,
            valueType: 'boolean',
            updatedAt: '2026-10-18T05:00:00.000Z',
            updatedByActorId: 'actor-ada',
            revision: state.revision,
          },
        ],
      });
    }
    if (at.endsWith('/settings/set_single_operator')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.writes.push(body);
      if (state.next === 'second-operator') {
        return json(
          {
            refused: true,
            code: 'SINGLE_OPERATOR_REFUSED',
            names: ['value'],
            fixes: ['Single-operator mode is on only while the business has one operator.'],
          },
          409,
        );
      }
      state.value = body['value'] === true;
      state.revision += 1;
      return json({
        recordId: 'single-operator',
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

const row = (page: Mounted): Element | null => page.find('[data-set="single-operator"]');
const save = (page: Mounted): HTMLButtonElement => {
  const found = page.find('[data-settings="save-single-operator"]');
  if (!(found instanceof HTMLButtonElement)) throw new Error('No single-operator Save');
  return found;
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

async function open(start: Partial<World> = {}) {
  const made = world(start);
  mounted = await mount(made.screen);
  await tick();
  return { ...made, page: mounted };
}

describe('the single-operator row', () => {
  it('reads the mode as the server holds it', async () => {
    const { page } = await open({ value: true });
    expect(
      row(page)?.querySelector('[data-settings="single-operator-value"]')?.textContent,
    ).toMatch(/\bon\b/u);
  });

  it('switches it on through settings.set_single_operator with the revision the read carried', async () => {
    const { page, state } = await open();
    await page.click('#settings-single-operator');
    await page.click('[data-settings="save-single-operator"]');
    await tick();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ value: true, expectedRevision: 3 });
    const commands = state.at.filter((at) => /\/settings\/set_/u.test(at));
    expect(commands.every((at) => at.endsWith('/settings/set_single_operator'))).toBe(true);
    expect(
      row(page)?.querySelector('[data-settings="single-operator-value"]')?.textContent,
    ).toMatch(/\bon\b/u);
  });

  it('says a second operator’s refusal in plain words, never its code', async () => {
    const { page } = await open({ next: 'second-operator' });
    await page.click('#settings-single-operator');
    await page.click('[data-settings="save-single-operator"]');
    await tick();
    const said = page.find('[data-settings="refusal"]')?.textContent ?? '';
    expect(said).toMatch(/one operator/iu);
    expect(page.text()).not.toContain('SINGLE_OPERATOR_REFUSED');
  });

  it('is closed without settings:manage and sends nothing', async () => {
    const { page, state } = await open({ manage: false });
    expect(save(page).disabled).toBe(true);
    await page.click('[data-settings="save-single-operator"]');
    await tick();
    expect(state.writes).toHaveLength(0);
  });
});
