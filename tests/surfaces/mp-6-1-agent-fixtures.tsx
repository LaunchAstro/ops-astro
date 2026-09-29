// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the Agent pane's fixtures: stored lineages shaped exactly as
// `task.read`'s proposal projection returns them, and the pane mounted over
// them with every control handed to the test.

import { AgentPane, type AgentPaneProps, type RunLineage } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

export const DIGEST = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

type Version = RunLineage['versions'][number];

export function version(overrides: Partial<Version> = {}): Version {
  return {
    versionId: 'v-1',
    version: 1,
    purpose: 'draft_the_reply',
    maximumMinor: 2_500,
    currency: 'AUD',
    payloadDigest: DIGEST,
    payload: {},
    supersededAt: null,
    runId: 'run-1',
    evidence: { digest: 'e1', body: {} },
    gate: {
      id: 'g-1',
      state: 'pending',
      round: 0,
      expiresAt: '2026-10-01T00:00:00.000Z',
      expired: false,
      payloadDigest: DIGEST,
    },
    checks: [],
    ...overrides,
  };
}

export function lineage(overrides: Partial<RunLineage> = {}): RunLineage {
  return {
    lineageId: 'l-1',
    state: 'live',
    versions: [version()],
    decisions: [],
    reservations: [],
    ...overrides,
  };
}

export const running: RunLineage['reservations'][number] = {
  state: 'held',
  heldMinor: 2_500,
  actualMinor: null,
  classifiedCause: null,
  lease: { state: 'live' },
  attempt: { state: 'dispatched' },
};

const live: Mounted[] = [];

/** Unmounts every pane mounted since the last call; each test file runs it after each test. */
export async function unmountAll(): Promise<void> {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
}

const ignore = (): void => {
  // The control is not under test here.
};

export async function pane(overrides: Partial<AgentPaneProps> = {}): Promise<Mounted> {
  const props: AgentPaneProps = {
    lineages: [lineage()],
    effect: null,
    nameOf: (id) => `person ${id}`,
    jobListOpen: false,
    onJobList: ignore,
    busy: false,
    refusal: null,
    onDecide: ignore,
    onReject: ignore,
    onCancel: ignore,
    ...overrides,
  };
  const page = await mount(<AgentPane {...props} />);
  live.push(page);
  return page;
}
