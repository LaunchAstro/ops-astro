// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel (MP-4-8), in the shell's panel slot until the dock frame
// (MP-3-1) draws panels in place. A new door or task remounts it; a new-task
// draft (MP-4-13) takes the same slot. Signed out, the slot is empty.
// `useDockPanel` holds the panel's state for the application: the host a
// screen opens rows through, what the slot draws, and whether the open panel
// is seated (the seat line, `seat-line.ts`, read from the frame's facts).

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { Session } from '../../session/token.ts';
import { DockSeat, useSeat } from './DockSeat.tsx';
import { DraftPanel } from './DraftPanel.tsx';
import { MOCK_FRAME, type FrameFactsSource } from './frame-seam.ts';
import { TaskPanel } from './Panel.tsx';
import { useTaskPanel, type TaskPanelState } from './panel-host.ts';

interface DockPanelProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly session: Session | null;
  readonly storage: Storage | null;
  /** The dock frame's facts; made up (and marked) until MP-3-1 joins. */
  readonly frame?: FrameFactsSource;
}

export function useDockPanel(props: DockPanelProps): {
  readonly host: TaskPanelState['host'];
  readonly panel: ReactElement | null;
  /** Whether an open panel sits seated, for the shell's `seated`. */
  readonly seated: boolean;
} {
  const taskPanel = useTaskPanel();
  const frame = props.frame ?? MOCK_FRAME;
  const seat = useSeat(frame);
  const open = props.session !== null && (taskPanel.draft !== null || taskPanel.opening !== null);
  return {
    host: taskPanel.host,
    panel: <DockPanel {...props} frame={frame} taskPanel={taskPanel} />,
    seated: open && seat.placement === 'seated',
  };
}

function DockPanel(
  props: DockPanelProps & {
    readonly frame: FrameFactsSource;
    readonly taskPanel: TaskPanelState;
  },
): ReactElement | null {
  const body = panelBody(props);
  return body === null ? null : <DockSeat source={props.frame}>{body}</DockSeat>;
}

function panelBody(
  props: DockPanelProps & { readonly taskPanel: TaskPanelState },
): ReactElement | null {
  const { client, grantKey, session, taskPanel } = props;
  if (session === null) return null;
  if (taskPanel.draft !== null) {
    return (
      <DraftPanel
        key={`${session.businessKey}:${session.email}`}
        client={client}
        storage={props.storage}
        person={`${session.businessKey}:${session.email}`}
        scope={taskPanel.draft}
        onCreated={(key) => {
          taskPanel.host.open(key, 'open');
          taskPanel.changed();
        }}
        onClose={taskPanel.close}
      />
    );
  }
  if (taskPanel.opening === null) return null;
  return (
    <TaskPanel
      key={`${taskPanel.opening.taskKey}\u0000${taskPanel.opening.door}\u0000${taskPanel.opening.tab ?? ''}`}
      client={client}
      grantKey={grantKey}
      opening={taskPanel.opening}
      changes={taskPanel.host.changes}
      onChanged={taskPanel.changed}
      onClose={taskPanel.close}
      onNewTask={taskPanel.openDraft}
      onLeaving={taskPanel.leaving}
      onDuplicated={(key) => {
        taskPanel.host.open(key, 'open');
        taskPanel.changed();
      }}
    />
  );
}
