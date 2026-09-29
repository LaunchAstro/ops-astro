// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the owner check reads the attribute the markup writes */
//
// C52-A, Settings ▸ Workflow triggers: each activation shows the standing
// approval it names, and a person adopts a newer version, rolls back, revokes
// the approval and turns the automation off, rollback and revocation as two
// controls. The server is a stub that keeps what it was sent, so each case
// proves the control goes through its own command at the revision the registry
// showed, and a reload shows the change.

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

interface Approval {
  id: string;
  versionId: string;
  act: 'adopted' | 'rolled_back';
  decidedBy: string;
  revoked: boolean;
}

interface Activation {
  id: string;
  versionId: string;
  versionNumber: number;
  mode: 'scheduled';
  everyMinutes: number;
  eventKind: null;
  enabled: boolean;
  changedBy: string;
  changedAt: string;
  revision: number;
  approval: Approval | null;
}

const registryOf = (activation: Activation): unknown => ({
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

const pin = (activation: Activation, number: number, how: Approval['act']): void => {
  Object.assign(activation, {
    versionId: `v-${String(number)}`,
    versionNumber: number,
    revision: activation.revision + 1,
    approval: {
      id: `s-${String(activation.revision)}`,
      versionId: `v-${String(number)}`,
      act: how,
      decidedBy: 'p-1',
      revoked: false,
    },
  });
};

function server(refuse?: string): {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
} {
  const sent: string[] = [];
  const activation: Activation = {
    id: 'a-1',
    versionId: 'v-1',
    versionNumber: 1,
    mode: 'scheduled',
    everyMinutes: 60,
    eventKind: null,
    enabled: true,
    changedBy: 'p-1',
    changedAt: '2026-09-29T00:00:00.000Z',
    revision: 3,
    approval: null,
  };
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/automation/registry')) return json(registryOf(activation));
    if (refuse !== undefined && at.endsWith(refuse)) {
      return json({ refused: true, code: 'VERSION_STALE', names: ['revision=9'], fixes: [] }, 409);
    }
    if (at.endsWith('/activation/adopt')) pin(activation, 2, 'adopted');
    else if (at.endsWith('/activation/roll_back')) pin(activation, 1, 'rolled_back');
    else if (at.endsWith('/approval/revoke') && activation.approval !== null) {
      activation.approval.revoked = true;
    } else if (at.endsWith('/activation/turn_off')) {
      Object.assign(activation, {
        enabled: false,
        approval: null,
        revision: activation.revision + 1,
      });
    } else return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    return json({ recordId: 'a-1', revision: activation.revision, detail: {} });
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as typeof globalThis.fetch;
  return { fetch, sent };
}

const clientOf = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });

/** The body the stub was sent on `route`, the last time. */
function bodyOf(sent: readonly string[], route: string): Record<string, unknown> {
  const call = sent.findLast((one) => one.includes(route)) ?? ' {}';
  return JSON.parse(call.slice(call.indexOf(' ') + 1)) as Record<string, unknown>;
}

const ROW = '[data-activation="a-1"]';

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('C52-A standing approvals on the Workflow triggers panel', () => {
  it('C52-A owner check: turning an automation off goes through activation.turn_off at the shown revision, and a reload shows it off', async () => {
    const stub = server();
    const client = clientOf(stub.fetch);
    const page = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(page.find('[data-activation="a-1"]')?.getAttribute('data-enabled')).toBe('true');
    await page.click(`${ROW} [data-control="turn-off"]`);
    await tick();
    expect(bodyOf(stub.sent, '/activation/turn_off')).toMatchObject({
      activationId: 'a-1',
      expectedRevision: 3,
    });
    await page.unmount();
    const again = await mount(<TriggersPanel client={client} />);
    await tick();
    expect(again.find('[data-activation="a-1"]')?.getAttribute('data-enabled')).toBe('false');
    expect(again.find(`${ROW} [data-control="turn-off"]`)).toBeNull();
    await again.unmount();
  });

  it('C52-A adopt, roll back and revoke: each its own control and command, at the shown revision', async () => {
    const stub = server();
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    const approval = (): string | null | undefined =>
      page.find('[data-activation="a-1"] [data-trigger="approval"]')?.textContent;
    expect(approval()).toContain('not approved');
    expect(page.find(`${ROW} [data-control="roll-back"]`)).toBeNull();
    expect(page.find(`${ROW} [data-control="revoke"]`)).toBeNull();

    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(bodyOf(stub.sent, '/activation/adopt')).toMatchObject({
      activationId: 'a-1',
      versionId: 'v-2',
      expectedRevision: 3,
    });
    expect(page.find('[data-activation="a-1"] [data-trigger="version"]')?.textContent).toContain(
      'v2',
    );
    expect(approval()).toContain('approved');
    expect(page.find(`${ROW} [data-control="adopt"]`)).toBeNull();

    await page.click(`${ROW} [data-control="revoke"]`);
    await tick();
    expect(bodyOf(stub.sent, '/approval/revoke')).toStrictEqual(
      expect.objectContaining({ approvalId: 's-3' }),
    );
    expect(approval()).toContain('revoked');
    expect(page.find('[data-activation="a-1"] [data-trigger="version"]')?.textContent).toContain(
      'v2',
    );
    expect(page.find(`${ROW} [data-control="revoke"]`)).toBeNull();

    await page.click(`${ROW} [data-control="roll-back"]`);
    await tick();
    expect(bodyOf(stub.sent, '/activation/roll_back')).toMatchObject({
      activationId: 'a-1',
      expectedRevision: 4,
    });
    expect(page.find('[data-activation="a-1"] [data-trigger="version"]')?.textContent).toContain(
      'v1',
    );
    expect(approval()).toContain('rolled back');
    await page.unmount();
  });

  it('C52-A a refused change is shown as it came and changes nothing on screen', async () => {
    const stub = server('/activation/adopt');
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.click(`${ROW} [data-control="adopt"]`);
    await tick();
    expect(page.find('[data-settings="triggers-refusal"]')?.textContent).toContain('VERSION_STALE');
    expect(page.find('[data-activation="a-1"] [data-trigger="version"]')?.textContent).toContain(
      'v1',
    );
    await page.unmount();
  });
});
