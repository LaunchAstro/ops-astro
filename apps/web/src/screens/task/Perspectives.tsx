// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team and Agent perspectives of one task (MP-4-3, DP-11 to DP-13, TP-12,
// TT-06).
//
// **One counting rule, for the page and the dock task panel.** Team counts
// the unfinished live subtasks; Agent counts the open gates, and with none
// open, one for staged output nobody has shipped. The mockup's page counted
// Agent from staged output alone while its panel counted gates first (D-07,
// not copied): both read `perspectiveCounts`. A count is a summary worked out
// at read, never a field on the task, and zero draws no badge.
//
// **An open gate is the live version's pending gate.** A decided gate, one
// the server reads as expired, and a pending gate on a superseded version are
// all closed: none of them is a decision a person can still make.
//
// **The panes are hidden, never unmounted** (`TabPanel`), so what was typed
// on one side survives a trip to the other. Which side is showing belongs to
// this reading of the task, not to the task: the page holds it above the read
// so a reread after a write keeps it.
//
// **The doors send an edit to the panel** (TT-06). The page reads; the dock
// task panel is where subtasks are ticked, time logged and the timer started.
// A door with no panel to open is drawn and cannot be pressed.

import { CountBadge, TabPanel, TabStrip } from '@launchastro/ui';
import type { ReactElement, ReactNode } from 'react';
import type { Perspective, PerspectiveCounts, StepMark } from './perspective-counts.ts';

export {
  perspectiveCounts,
  stepMarks,
  type Perspective,
  type PerspectiveCounts,
  type StepMark,
} from './perspective-counts.ts';

export type PanelDoor = 'open' | 'tick' | 'add-first' | 'log' | 'timer' | 'reply';

/** The conversation's three tabs (MP-4-5); the reply door hands the one showing to the panel. */
export type ConversationTab = 'internal' | 'client' | 'all';

/** Opens the dock task panel through a door, on the conversation tab it was pressed from. */
export type PanelOpener = (door: PanelDoor, tab?: ConversationTab) => void;

const DOOR_WORDS: Readonly<Record<PanelDoor, string>> = {
  open: 'Open this task in the panel',
  tick: 'Tick these off in the task panel',
  'add-first': 'Add the first one in the task panel',
  log: 'Log time in the task panel',
  timer: 'Start the timer in the task panel',
  reply: 'Reply in the task panel',
};

export function PanelDoorButton(props: {
  readonly door: PanelDoor;
  /** The conversation tab showing, for the reply door. */
  readonly tab?: ConversationTab;
  readonly onOpenPanel: PanelOpener | undefined;
}): ReactElement {
  const open = props.onOpenPanel;
  return (
    <button
      className="tt__more"
      type="button"
      data-panel-door={props.door}
      disabled={open === undefined}
      onClick={() => {
        open?.(props.door, props.tab);
      }}
    >
      {DOOR_WORDS[props.door]}
    </button>
  );
}

export function Perspectives(props: {
  /** The tab strip's name, which its ids carry: the dock task panel's is its own. */
  readonly name?: string;
  readonly counts: PerspectiveCounts;
  readonly selected: Perspective;
  readonly onSelect: (next: Perspective) => void;
  readonly team: ReactNode;
  readonly agent: ReactNode;
}): ReactElement {
  const { counts } = props;
  const name = props.name ?? 'perspective';
  const teamTitle = `${counts.team} unfinished ${counts.team === 1 ? 'subtask' : 'subtasks'}`;
  return (
    <div className="tpr__perspectives" data-perspectives>
      <TabStrip
        name={name}
        label="Team and agent views of this task"
        selected={props.selected}
        onSelect={(next) => {
          props.onSelect(next === 'agent' ? 'agent' : 'team');
        }}
        tabs={[
          {
            id: 'team',
            label: 'Team',
            badge: <CountBadge count={counts.team} title={teamTitle} />,
          },
          {
            id: 'agent',
            label: 'Agent',
            badge: <CountBadge count={counts.agent} title={counts.agentTitle} />,
          },
        ]}
      />
      <TabPanel name={name} tab="team" selected={props.selected}>
        {props.team}
      </TabPanel>
      <TabPanel name={name} tab="agent" selected={props.selected}>
        {props.agent}
      </TabPanel>
    </div>
  );
}

/**
 * The Team side's subtask and time sections, as the page reads them. The
 * subtask list (MP-4-4, `Subtasks.tsx`) and the time log (MP-4-6, `Time.tsx`)
 * are placed under their headings; without a time log the section says it has
 * nothing and points at the panel.
 */
export function TeamWork(props: {
  readonly steps: readonly StepMark[];
  readonly list?: ReactNode;
  readonly time?: ReactNode;
  readonly onOpenPanel: PanelOpener | undefined;
  /** False inside the panel itself, where the edit already happens. */
  readonly doors?: boolean;
}): ReactElement {
  const live = props.steps.filter((step) => !step.retired);
  const doors = props.doors ?? true;
  return (
    <>
      <section className="sb__sect" data-steps>
        <div className="sb__sh">
          <span className="sb__k">Subtasks</span>
        </div>
        {props.list}
        {live.length === 0 ? <p className="card__sub">No subtasks on this one yet.</p> : null}
        {doors ? (
          <PanelDoorButton
            door={live.length === 0 ? 'add-first' : 'tick'}
            onOpenPanel={props.onOpenPanel}
          />
        ) : null}
      </section>
      <section className="sb__sect" data-time>
        <div className="sb__sh">
          <span className="sb__k">Time</span>
        </div>
        {props.time ?? <p className="card__sub">No time logged yet.</p>}
        {doors ? <PanelDoorButton door="log" onOpenPanel={props.onOpenPanel} /> : null}
        {doors ? <PanelDoorButton door="timer" onOpenPanel={props.onOpenPanel} /> : null}
      </section>
    </>
  );
}
