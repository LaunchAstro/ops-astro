// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's Agent side (S3, DA-01 to DA-09) and its head's Ask
// about this task (DP-09).
//
// **The page's pane, on the panel's own read.** The Agent side is the brief
// (MP-4-7) above the task page's Agent pane (`views/agent-pane.tsx`, MP-6-1):
// the run, the staged output, the gate, the stops and the tokens, each control
// on the same command the page sends, naming the gate, version, run or stop
// the panel's read showed. Every outcome asks the host to count a change, so
// the page and the panel both read again. A refused decision is held above
// the panel's read (`Panel.tsx`), as the task page holds it: a reread that
// answers unavailable unmounts this side, and the note lasts as long as this
// task's panel.
// The panel's read is kept drawn through a reread, so an open step-up prompt
// is never unmounted mid-code and needs no hold of its own.
//
// **Ask drafts, never sends.** The head's Ask opens the dock's assistant with
// the task in scope (`assistant/asks.ts`), under the panel's own session.

import { Icon } from '@launchastro/ui';
import type { ReactElement } from 'react';
import type {
  InternalTaskDetail as Task,
  PersonListResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { askDrawer, taskAsk } from '../../assistant/asks.ts';
import { useRead } from '../../data/use-read.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { AgentSection } from '../../views/agent-pane.tsx';
import { keepsClosure, type DecisionNote } from '../../views/gate-controls.tsx';
import { useSharedNote } from '../../views/decision-closures.tsx';
import { useHeld } from './held-state.ts';
import { BriefField } from './Writing.tsx';

export interface AgentSideProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  readonly taskRead: Task;
  readonly onChanged: () => void;
  /** The refused decision, held above the panel's read. */
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
}

/** The task as an ask or the pane names it: its title, or its key while it has none. */
const titleOf = (task: Task): string =>
  task.title === null || task.title === '' ? task.key : task.title;

/** The task in scope for the drawer, its client as the read sent it (AW-04). */
const scopeOf = (task: Task) => ({
  id: task.id,
  title: titleOf(task),
  clientId: task.client,
  ...(task.clientSet && task.client === null ? { clientUnseen: true as const } : {}),
});

/**
 * The refused decision for one task under one grant, held by the panel above
 * its read, as the task page holds its own: dropped when the task or the reader
 * changes, or the read is denied.
 */
export function useDecisionNote(
  panel: { readonly grantKey: string; readonly opening: { readonly taskKey: string } },
  outcome: string,
): Pick<AgentSideProps, 'note' | 'onDecided'> {
  const [note, onDecided] = useHeld<DecisionNote>(
    `${panel.grantKey}\u0000${panel.opening.taskKey}`,
    outcome === 'denied',
    keepsClosure,
  );
  return { note, onDecided };
}

export function PanelAgent(props: AgentSideProps): ReactElement {
  const { client, task } = props;
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    deps: [],
  });
  return (
    <>
      <AgentSection
        brief={
          <BriefField
            client={client}
            recordId={task.id}
            revision={task.revision}
            value={task.agentBrief}
            onSaved={props.onChanged}
          />
        }
        client={client}
        grantKey={props.grantKey}
        recordId={task.id}
        title={titleOf(task)}
        clientId={task.client}
        clientUnseen={task.clientSet && task.client === null}
        taskKey={task.key}
        readOf={props.taskRead}
        proposals={task.proposals}
        people={people.state.outcome === 'ready' ? people.state.value.persons : []}
        ledger={task.ledger}
        onChanged={props.onChanged}
        {...useSharedNote(task.id, props.note, props.onDecided)}
      />
    </>
  );
}

/** DP-09: ask the agent where the task is up to; the drawer drafts it and sends nothing. */
export function AskDoor(props: { readonly grantKey: string; readonly task: Task }): ReactElement {
  return (
    <button
      className="ask"
      type="button"
      data-panel-head="ask"
      aria-label="Ask about this task"
      title="Ask about this task"
      onClick={() => {
        askDrawer(taskAsk(scopeOf(props.task)), props.grantKey);
      }}
    >
      <Icon name="sparkles" size="sm" />
    </button>
  );
}
