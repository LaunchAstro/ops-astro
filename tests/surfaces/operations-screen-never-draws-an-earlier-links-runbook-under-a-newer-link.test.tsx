// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Following one breach runbook evidence link and then another keeps the
// operations screen mounted (it is keyed on the grant alone). Every commit
// the browser could paint must answer the address it is drawn at: the first
// link's runbook version is never drawn under the second link's address.
// A layout-effect probe reads the DOM at each commit, before passive effects
// run, which is what a paint between commit and effect would show.

import { useLayoutEffect, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { OperationsScreen } from '../../apps/web/src/screens/Operations.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const HEALTH = { checkedAt: '2026-09-30T08:00:00.000Z', sources: [], services: [] };

const answer = (version: string) => ({
  ok: true,
  unattended: [],
  privacyIncidents: [],
  breachRunbook: {
    version,
    digest: `sha256:${version}`,
    publishedAt: '2026-09-28T00:00:00.000Z',
    body: '# Breach runbook',
  },
  serviceHealth: HEALTH,
});

describe('the operations screen across two runbook evidence links', () => {
  it('never draws the first link’s runbook version at the second link’s address', async () => {
    const client = {
      businessKey: 'alpha',
      read: (_name: string, body: Readonly<Record<string, unknown>>) =>
        body['runbookVersion'] === '1.0'
          ? Promise.resolve({ ok: true, value: answer('1.0') })
          : new Promise(() => {
              // The second link's read is still in flight.
            }),
      newOperationId: () => 'op',
      mutate: () =>
        new Promise(() => {
          // Never answered.
        }),
    } as unknown as OperationsClient;

    const seen: { address: string; runbook: string | null }[] = [];
    function Probe(props: { readonly address: string }): null {
      useLayoutEffect(() => {
        seen.push({
          address: props.address,
          runbook:
            document.querySelector<HTMLElement>('[data-runbook]')?.dataset['runbook'] ?? null,
        });
      });
      return null;
    }
    const at = (address: string): ReactElement => (
      <>
        <OperationsScreen client={client} grantKey="alpha\u0000ada" address={address} />
        <Probe address={address} />
      </>
    );

    const first = '/settings/operations/?runbook=1.0&digest=sha256%3A1.0';
    const second = '/settings/operations/?runbook=2.0&digest=sha256%3A2.0';
    const view = await mount(at(first));
    await view.render(at(first));
    expect((view.find('[data-runbook]') as HTMLElement | null)?.dataset['runbook']).toBe('1.0');

    await view.render(at(second));
    const underSecond = seen.filter((commit) => commit.address === second);
    expect(underSecond.map((commit) => commit.runbook)).not.toContain('1.0');
    await view.unmount();
  });
});
