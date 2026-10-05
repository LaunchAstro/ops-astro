// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the owner check reads the attribute the markup writes */
//
// C33, Settings ▸ Workflow triggers: each automation shows its mode and pinned
// version, and switching one to manual is recorded (the owner check, in the
// browser's half). The server is a stub that keeps what it was sent, so the
// case proves the switch goes through `activation.change` at the revision the
// registry showed, and a reload shows it. A press whose answer was lost is
// sent again as the same attempt; an answer for a business the panel no
// longer shows is dropped.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TriggersPanel } from '../../apps/web/src/screens/settings/triggers.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

/** The registry the stub serves: one automation, two versions, one activation. */
function registryOf(
  activation: Readonly<Record<string, unknown>>,
  name = 'Weekly report',
): unknown {
  return {
    ok: true,
    definitions: [
      {
        id: 'd-1',
        kind: 'automation',
        name,
        versions: [1, 2].map((number) => ({
          id: `v-${String(number)}`,
          number,
          contentDigest: 'a'.repeat(64),
          contentSize: 10,
          modes: ['manual', 'scheduled'],
          releasedBy: 'p-1',
          releasedAt: '2026-09-28T00:00:00.000Z',
        })),
        activations: [activation],
      },
    ],
  };
}

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
}

function server(options: { readonly refuse?: boolean; readonly lose?: number } = {}): Stub {
  const sent: string[] = [];
  let lose = options.lose ?? 0;
  const activation = {
    id: 'a-1',
    versionId: 'v-2',
    versionNumber: 2,
    mode: 'scheduled',
    everyMinutes: 60,
    eventKind: null,
    enabled: true,
    changedBy: 'p-1',
    changedAt: '2026-09-29T00:00:00.000Z',
    revision: 3,
  };
  const answer = (at: string, body: string): Response => {
    sent.push(`${at} ${body}`);
    if (at.endsWith('/automation/registry')) {
      return options.refuse === true
        ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['ask'] }, 403)
        : json(registryOf(activation));
    }
    if (at.endsWith('/activation/change')) {
      Object.assign(activation, {
        mode: 'manual',
        everyMinutes: null,
        revision: activation.revision + 1,
      });
      return json({ recordId: 'a-1', revision: activation.revision, detail: {} });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/activation/change') && lose > 0) {
      // The change is not applied and the answer never arrives.
      lose -= 1;
      sent.push(`${at} ${String(init?.body ?? '')}`);
      throw new Error('the connection dropped');
    }
    return await Promise.resolve(answer(at, String(init?.body ?? '')));
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const clientOf = (fetch: typeof globalThis.fetch, businessKey = 'alpha'): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

const changes = (stub: Stub): readonly Record<string, unknown>[] =>
  stub.sent
    .filter((call) => call.includes('/activation/change'))
    .map((call) => JSON.parse(call.slice(call.indexOf(' ') + 1)) as Record<string, unknown>);

// eslint-disable-next-line max-lines-per-function -- the owner check and its three edges
describe('C33 Workflow triggers panel', () => {
  it('C33 owner check: each automation shows its mode and pinned version, and switching one to manual is recorded', async () => {
    const stub = server();
    const client = clientOf(stub.fetch);
    const page = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(page.find('[data-activation="a-1"]')?.getAttribute('data-mode')).toBe('scheduled');
    expect(page.find('[data-activation="a-1"] [data-trigger="version"]')?.textContent).toContain(
      'v2',
    );
    expect(page.find('[data-activation="a-1"] [data-trigger="mode"]')?.textContent).toContain(
      'every 60 minutes',
    );
    expect(page.find('[data-definition="d-1"]')?.textContent).toContain('Weekly report');
    await page.click('[data-activation="a-1"] [data-control="manual"]');
    await tick();
    const [body] = changes(stub);
    expect(body).toMatchObject({
      activationId: 'a-1',
      versionId: 'v-2',
      mode: 'manual',
      enabled: true,
      expectedRevision: 3,
    });
    expect(body?.['everyMinutes']).toBeUndefined();

    await page.unmount();
    const again = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(again.find('[data-activation="a-1"]')?.getAttribute('data-mode')).toBe('manual');
    expect(again.find('[data-activation="a-1"] [data-control="manual"]')).toBeNull();
    await again.unmount();
  });

  it('C33 a caller refused the registry is shown the refusal and no automation', async () => {
    const page = await mount(<TriggersPanel client={clientOf(server({ refuse: true }).fetch)} />);
    await tick();
    expect(page.text()).toContain('not permitted');
    expect(page.find('[data-activation]')).toBeNull();
    await page.unmount();
  });

  it('C33 a switch whose answer was lost is sent again as the same attempt', async () => {
    const stub = server({ lose: 1 });
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.click('[data-activation="a-1"] [data-control="manual"]');
    await tick();
    expect(page.find('[data-settings="triggers-refusal"]')?.textContent).toContain('dropped');
    expect(page.find('[data-activation="a-1"]')?.getAttribute('data-mode')).toBe('scheduled');
    await page.click('[data-activation="a-1"] [data-control="manual"]');
    await tick();
    const [lost, resent] = changes(stub);
    expect(resent?.['operationId']).toBe(lost?.['operationId']);
    expect(typeof lost?.['operationId']).toBe('string');
    expect(page.find('[data-activation="a-1"]')?.getAttribute('data-mode')).toBe('manual');
    await page.unmount();
  });

  it('C33 a business switch drops the last business rows and its late answer', async () => {
    const held: ((response: Response) => void)[] = [];
    const slow = (() =>
      new Promise<Response>((resolve) => {
        held.push(resolve);
      })) as typeof globalThis.fetch;
    const page = await mount(<TriggersPanel client={clientOf(slow)} />);
    await tick();
    const bravo = server();
    await page.render(<TriggersPanel client={clientOf(bravo.fetch, 'bravo')} />);
    await tick();
    expect(page.find('[data-activation="a-1"]')?.textContent).toContain('Weekly report');
    await act(async () => {
      held[0]?.(json(registryOf({ id: 'a-9', versionId: 'v-1', versionNumber: 1 }, 'Alpha only')));
      await Promise.resolve();
    });
    await tick();
    expect(held).toHaveLength(1);
    expect(page.text()).not.toContain('Alpha only');
    expect(page.find('[data-activation="a-9"]')).toBeNull();
    await page.unmount();
  });
});

describe('C33 Workflow triggers panel look', () => {
  it('C33 look: each activation draws as a page row in one list card, with no approval chip', async () => {
    const page = await mount(<TriggersPanel client={clientOf(server().fetch)} />);
    await tick();
    expect(page.find('[data-settings="triggers"]')?.className).toBe('card card--flush');
    expect(page.find('[data-settings="triggers"] .card__title')?.textContent).toBe(
      'Workflow triggers',
    );
    expect(page.all('[data-settings="trigger-rows"]')).toHaveLength(1);
    const row = page.find('[data-activation="a-1"]');
    expect(row?.className).toBe('lrow lrow--page');
    expect(row?.getAttribute('data-definition')).toBe('d-1');
    expect(row?.querySelector('.lrow__title')?.textContent).toBe('Weekly report');
    expect(row?.querySelector('.lrow__meta')?.textContent).toBe(
      'Automation · scheduled, every 60 minutes · pinned to v2 · on',
    );
    expect(row?.querySelector('.chip')).toBeNull();
    const controls = [...(row?.querySelectorAll('.lrow__trail .btn') ?? [])];
    expect(controls.map((control) => control.getAttribute('data-control'))).toEqual(['manual']);
    await page.unmount();
  });
});
