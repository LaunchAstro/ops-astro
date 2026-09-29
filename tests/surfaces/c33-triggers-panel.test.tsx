// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the owner check reads the attribute the markup writes */
//
// C33, Settings ▸ Workflow triggers: each automation shows its mode and pinned
// version, and switching one to manual is recorded (the owner check, in the
// browser's half). The server is a stub that keeps what it was sent, so the
// case proves the switch goes through `activation.change` at the revision the
// registry showed, and a reload shows it.

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

function server(refuse = false): {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
} {
  const sent: string[] = [];
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
  const registry = (): unknown => ({
    ok: true,
    definitions: [
      {
        id: 'd-1',
        kind: 'automation',
        name: 'Weekly report',
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
  });
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/automation/registry')) {
      return refuse
        ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['ask'] }, 403)
        : json(registry());
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
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as typeof globalThis.fetch;
  return { fetch, sent };
}

const clientOf = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });

describe('C33 Workflow triggers panel', () => {
  it('C33 owner check: each automation shows its mode and pinned version, and switching one to manual is recorded', async () => {
    const stub = server();
    const client = clientOf(stub.fetch);
    const page = await mount(<TriggersPanel client={client} />);
    await tick();
    const row = '[data-activation="a-1"]';
    expect(page.find(row)?.getAttribute('data-mode')).toBe('scheduled');
    expect(page.find(`${row} [data-trigger="version"]`)?.textContent).toContain('v2');
    expect(page.find(`${row} [data-trigger="mode"]`)?.textContent).toContain('every 60 minutes');
    expect(page.find('[data-definition="d-1"]')?.textContent).toContain('Weekly report');
    await page.click(`${row} button`);
    await tick();
    const change = stub.sent.find((call) => call.includes('/activation/change')) ?? '';
    const body = JSON.parse(change.slice(change.indexOf(' ') + 1)) as Record<string, unknown>;
    expect(body).toMatchObject({
      activationId: 'a-1',
      versionId: 'v-2',
      mode: 'manual',
      enabled: true,
      expectedRevision: 3,
    });
    expect(body['everyMinutes']).toBeUndefined();

    await page.unmount();
    const again = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(again.find(row)?.getAttribute('data-mode')).toBe('manual');
    expect(again.find(`${row} button`)).toBeNull();
    await again.unmount();
  });

  it('C33 a caller refused the registry is shown the refusal and no automation', async () => {
    const page = await mount(<TriggersPanel client={clientOf(server(true).fetch)} />);
    await tick();
    expect(page.text()).toContain('not permitted');
    expect(page.find('[data-activation]')).toBeNull();
    await page.unmount();
  });
});
