// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- read the section's DOM attribute */

import { expect, it } from 'vitest';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { AGENT_PROPOSALS } from '../visual/made-up-agent.ts';
import { mount } from './mount.tsx';
import { run, step, tick } from './mp-6-3-fixture.tsx';

const lineage = AGENT_PROPOSALS[0];
const version = lineage?.versions[0];
if (lineage === undefined || version === undefined || version.gate === null)
  throw new Error('missing proposal fixture');
const approved = {
  ...version,
  startedAt: null,
  endedAt: null,
  gate: { ...version.gate, state: 'approved' },
};
const original: readonly ProposalView[] = [{ ...lineage, versions: [approved] }];

// Each newer task read leaves the approved gate in place while it no longer
// authorises work (pickup's approvalCurrent), before the run's own re-read lands.
const changes: readonly { readonly change: string; readonly revised: readonly ProposalView[] }[] = [
  {
    // Proposal-writer retains an approved gate as history when its version is
    // superseded. The successor may name a different step, leaving draft with
    // this old run as its newest run, now no longer authorised by that gate.
    change: 'superseding an approved version',
    revised: [
      {
        ...lineage,
        versions: [
          {
            ...version,
            versionId: 'v-3',
            version: 3,
            runId: 'run-3',
            startedAt: null,
            endedAt: null,
          },
          { ...approved, supersededAt: '2026-10-04T01:00:00.000Z' },
        ],
      },
    ],
  },
  {
    // Lease retirement cancels the lineage and leaves its version and approved
    // gate as they were.
    change: "cancelling an approved version's lineage",
    revised: [{ ...lineage, state: 'cancelled', versions: [approved] }],
  },
];

// The run as the first read answers it: planned on draft, which send waits on.
const firstRead = {
  execution: {
    outcome: 'ready',
    runs: [
      {
        runId: 'run-2',
        lineageId: lineage.lineageId,
        versionId: version.versionId,
        state: 'planned',
        taskRevisionAtRequest: 1,
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    ],
    events: [],
    complete: true,
    next: null,
    graph: {
      plan: 'bound',
      sourceRevision: 1,
      complete: true,
      steps: [step('draft', [], ['run-2']), step('review', []), step('send', ['draft'])],
      nodes: [
        {
          ...run('run-2', 'not_started'),
          planned: { key: 'draft', title: 'The draft step' },
          observed: { ...run('run-2', 'not_started').observed, attemptId: null },
        },
      ],
    },
  },
};

it.each(changes)(
  'MP-6-3 a newer task read $change leaves its held graph dependency waiting',
  async ({ revised }) => {
    let reads = 0;
    let release: ((answer: Response) => void) | undefined;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: () => {
        reads += 1;
        if (reads > 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return Promise.resolve(Response.json(firstRead));
      },
    });
    const draw = (readOf: number, proposals: readonly ProposalView[]) => (
      <RunProgress
        client={client}
        grantKey="alpha:ada"
        taskKey="T-1"
        readOf={readOf}
        proposals={proposals}
      />
    );
    const page = await mount(draw(1, original));
    try {
      await tick();
      expect(page.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
        'After draft',
      );
      await page.render(draw(2, revised));
      await tick();
      expect(release).toBeDefined();
      expect(page.find('[data-run-progress]')?.getAttribute('data-outcome')).toBe('loading');
      expect(page.find('[data-execution-map="bound"]')).not.toBeNull();
      expect({
        dependency: page.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent,
        blockedLines: page.all('.tg__edge--wait').length,
        saysDone: page.find('[data-tg-node="draft"] .tg__nout')?.textContent === 'OUT Done',
      }).toEqual({ dependency: 'Waiting on draft', blockedLines: 1, saysDone: false });
    } finally {
      await page.unmount();
    }
  },
);
