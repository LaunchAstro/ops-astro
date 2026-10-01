// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel (MP-4-8), in the shell's panel slot until the dock frame
// (MP-3-1) draws panels in place. A new door or task remounts it; a new-task
// draft (MP-4-13) takes the same slot. Signed out, the slot is empty.
// `useDockPanel` holds the panel's state for the application: the host a
// screen opens rows through, and what the slot draws.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { Session } from '../../session/token.ts';
import { DraftPanel } from './DraftPanel.tsx';
import { TaskPanel } from './Panel.tsx';
import { useTaskPanel, type TaskPanelState } from './panel-host.ts';

interface DockPanelProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly session: Session | null;
  readonly storage: Storage | null;
}

export function useDockPanel(props: DockPanelProps): {
  readonly host: TaskPanelState['host'];
  readonly panel: ReactElement | null;
} {
  const taskPanel = useTaskPanel();
  return { host: taskPanel.host, panel: <DockPanel {...props} taskPanel={taskPanel} /> };
}

function DockPanel(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly session: Session | null;
  readonly storage: Storage | null;
  readonly taskPanel: TaskPanelState;
}): ReactElement | null {
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
