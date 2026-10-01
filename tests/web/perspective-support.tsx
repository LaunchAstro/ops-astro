// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the MP-4-3 suites: pages that are always unmounted, a lineage
// whose head version carries a gate in a given state, and readers for the
// switch's badges and panes.

import { act, type ReactElement } from 'react';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { perspectiveCounts } from '../../apps/web/src/screens/task/perspective-counts.ts';
import { mount as mountOnce, type Mounted } from '../surfaces/mount.tsx';
import { page as pageOnce, type Answers } from './task-page-stub.tsx';

// A test that fails before its own unmount leaves its page mounted, and a
// page left behind can disturb the next test's reads. Every view is kept here
// until `unmountAll`, whichever way the test ended.
const live = new Set<Mounted>();

const kept = (view: Mounted): Mounted => {
  live.add(view);
  return {
    ...view,
    unmount: async () => {
      if (!live.delete(view)) return;
      await view.unmount();
    },
  };
};

export const mount = async (element: ReactElement): Promise<Mounted> =>
  kept(await mountOnce(element));

export const page = async (taskKey: string, answers: Answers): Promise<Mounted> =>
  kept(await pageOnce(taskKey, answers));

/** Unmount every page still mounted: each suite calls it after each test. */
export const unmountAll = async (): Promise<void> => {
  for (const view of live) {
    live.delete(view);
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    await view.unmount();
  }
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One lineage whose head version carries a gate in this state. */
export const gated = (
  name: string,
  gate: { readonly state: string; readonly expired?: boolean } | null,
  supersededAt: string | null = null,
): ProposalView => ({
  lineageId: `l-${name}`,
  state: 'live',
  versions: [
    {
      versionId: `v-${name}`,
      version: 1,
      purpose: 'draft',
      maximumMinor: 100,
      currency: 'AUD',
      payloadDigest: `d-${name}`,
      payload: {},
      supersededAt,
      runId: null,
      evidence: null,
      gate:
        gate === null
          ? null
          : {
              id: `g-${name}`,
              state: gate.state,
              round: 1,
              expiresAt: '2999-01-01T00:00:00.000Z',
              expired: gate.expired ?? false,
              payloadDigest: `d-${name}`,
            },
    },
  ],
  decisions: [],
  reservations: [],
});

export const open = (name: string): ProposalView => gated(name, { state: 'pending' });

export const step = (done: boolean, retired = false) => ({ done, retired });

export const counts = (over: {
  readonly steps?: readonly { done: boolean; retired: boolean }[];
  readonly proposals?: readonly ProposalView[];
  readonly stagedOutput?: boolean;
}) =>
  perspectiveCounts({
    steps: over.steps ?? [],
    proposals: over.proposals ?? [],
    stagedOutput: over.stagedOutput ?? false,
  });

export const badge = (view: Mounted, tab: string): string | null =>
  view.find(`[data-tabs="perspective"] #perspective-tab-${tab} .cbadge`)?.textContent ?? null;

export const paneHidden = (view: Mounted, tab: string): boolean | undefined =>
  view.find(`#perspective-panel-${tab}`)?.hasAttribute('hidden');

export const press = async (view: Mounted, selector: string, key: string): Promise<void> => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

/** A keystroke into a textarea, through the element's own value setter. */
export const typeInto = async (view: Mounted, selector: string, text: string): Promise<void> => {
  const field = view.host.querySelector(selector);
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
