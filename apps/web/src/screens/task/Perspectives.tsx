// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's Team | Agent switch (TP-12, DS-COMP-23 static) and its two
// panes. Both panes stay mounted and switch by `hidden`, the mockup's rule: a
// switch never re-renders a pane, so a half-typed comment or proposal on the
// other side is still there when a person comes back.
//
// Which side is open is a fact about this reading, not the task, so the page
// holds it above the read (`TaskDetail.tsx`) and a reread keeps it.
//
// The Agent tab counts what is waiting on a person: the open gates on the
// head versions of live lineages, the gates the page offers a decision on.

import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { CountBadge, TabPanel, TabStrip } from '@launchastro/ui';
import type { ProposalView } from '../../../../../packages/core-wire/src/index.ts';
import { lapsed } from '../../views/gate-controls.tsx';

export type Perspective = 'team' | 'agent';

const NAME = 'perspective';

export function Perspectives(props: {
  readonly selected: Perspective;
  readonly onSelect: (next: Perspective) => void;
  readonly proposals: readonly ProposalView[] | undefined;
  readonly team: ReactNode;
  readonly agent: ReactNode;
}): ReactElement {
  const strip = useRef<HTMLDivElement>(null);
  usePlacedMark(strip, props.selected);
  const waiting = openGates(props.proposals ?? []);
  // One block, so the page's stack spacing never parts the switch from the
  // pane: the mark sits on the first section's rule, as the mockup draws it.
  return (
    <div data-perspectives="">
      <div ref={strip}>
        <TabStrip
          label="Team and agent views of this task"
          name={NAME}
          selected={props.selected}
          onSelect={(id) => {
            props.onSelect(id === 'agent' ? 'agent' : 'team');
          }}
          tabs={[
            { id: 'team', label: 'Team' },
            {
              id: 'agent',
              label: 'Agent',
              badge: <CountBadge count={waiting} title="Gates waiting on a decision" />,
            },
          ]}
        />
      </div>
      <TabPanel name={NAME} tab="team" selected={props.selected}>
        <div className="stack" data-tp-pane="team">
          {props.team}
        </div>
      </TabPanel>
      <TabPanel name={NAME} tab="agent" selected={props.selected}>
        <div data-tp-pane="agent">{props.agent}</div>
      </TabPanel>
    </div>
  );
}

/** Open gates a person can decide: the head version's, on a live lineage. */
function openGates(proposals: readonly ProposalView[]): number {
  return proposals.filter((lineage) => {
    const gate = lineage.versions[0]?.gate ?? null;
    return lineage.state === 'live' && gate !== null && gate.state === 'pending' && !lapsed(gate);
  }).length;
}

/**
 * Puts the strip's sliding mark under the selected tab (the mockup's
 * `placeMark`): snapped on arrival, sliding on a switch, and placed again once
 * the faces have loaded, because a tab's width is its word's width.
 */
function usePlacedMark(host: { readonly current: HTMLElement | null }, selected: string): void {
  const placed = useRef(false);
  useLayoutEffect(() => {
    const place = (snap: boolean): void => {
      const row = host.current?.querySelector<HTMLElement>('.cmtabs');
      const mark = row?.querySelector<HTMLElement>('.cmtabs__mark');
      const on = row?.querySelector<HTMLElement>('.cmtab[aria-selected="true"]');
      if (row === undefined || row === null || mark === null || mark === undefined) return;
      if (on === null || on === undefined) return;
      if (snap) row.classList.add('is-placing');
      mark.style.left = `${String(on.offsetLeft)}px`;
      mark.style.width = `${String(on.offsetWidth)}px`;
      // Off again after the frame that drew it, so only a switch slides.
      if (snap) {
        setTimeout(() => {
          row.classList.remove('is-placing');
        }, 50);
      }
    };
    if (placed.current) {
      place(false);
      return;
    }
    placed.current = true;
    place(true);
    if ('fonts' in document) {
      void (async () => {
        await document.fonts.ready;
        place(true);
      })();
    }
  }, [host, selected]);
}
