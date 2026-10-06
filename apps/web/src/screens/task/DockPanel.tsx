// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel (MP-4-8), drawn by the dock as its `task` panel
// (dock/task-dock.ts). A new door or task remounts it; a new-task draft
// (MP-4-13) takes the same panel. Signed out, there is nothing to draw.
// `useDockPanel` holds the panel's state for the application: the host a
// screen opens rows through, and what the dock draws.

import type { ReactElement } from 'react';
import { pathTo } from '../../routes.ts';
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
  /** What the dock draws: open while a task or a draft is, its door, and its own close. */
  readonly panel: {
    readonly open: boolean;
    readonly body: ReactElement;
    readonly door: string;
    /** False, closing nothing, while the draft's Create is out. */
    readonly close: () => boolean;
    /** A draft filed from the page or a door (DN-02); null signed out. */
    readonly file: TaskPanelState['file'] | null;
  };
} {
  const { grantKey, session, storage } = props;
  const taskPanel = useTaskPanel({
    key: grantKey,
    person: session === null ? null : `${session.businessKey}:${session.email}`,
    storage,
  });
  const { opening, draft } = taskPanel;
  return {
    host: taskPanel.host,
    panel: {
      open: session !== null && (opening !== null || draft !== null),
      body: <DockPanel {...props} taskPanel={taskPanel} />,
      door:
        opening === null
          ? pathTo('agency:projects-board')
          : pathTo('agency:task-detail', { key: opening.taskKey }),
      close: taskPanel.close,
      file: session === null ? null : taskPanel.file,
    },
  };
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
        key={grantKey}
        client={client}
        storage={props.storage}
        person={`${session.businessKey}:${session.email}`}
        scope={taskPanel.draft}
        onCreated={(key) => {
          taskPanel.host.open(key, 'open');
          taskPanel.changed();
        }}
        onClose={taskPanel.close}
        docked
        hold={taskPanel.hold}
      />
    );
  }
  if (taskPanel.opening === null) return null;
  return (
    <TaskPanel
      key={`${grantKey}\u0000${taskPanel.opening.taskKey}\u0000${taskPanel.opening.door}\u0000${taskPanel.opening.tab ?? ''}`}
      client={client}
      grantKey={grantKey}
      opening={taskPanel.opening}
      changes={taskPanel.host.changes}
      onChanged={taskPanel.changed}
      onClose={taskPanel.close}
      docked
      onNewTask={taskPanel.openDraft}
      onLeaving={taskPanel.leaving}
      onDuplicated={(key) => {
        taskPanel.host.open(key, 'open');
        taskPanel.changed();
      }}
    />
  );
}
