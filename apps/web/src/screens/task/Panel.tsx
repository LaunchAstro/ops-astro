// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's body (MP-4-8). Not built yet: its tests come first.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { ConversationTab } from './Comments.tsx';
import type { PanelDoor } from './Perspectives.tsx';

/** What opened the panel: the task, the door pressed, and the conversation tab it was pressed on. */
export interface PanelOpening {
  readonly taskKey: string;
  readonly door: PanelDoor;
  readonly tab: ConversationTab | null;
}

export interface TaskPanelProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly opening: PanelOpening;
  readonly changes?: number;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}

export function TaskPanel(_props: TaskPanelProps): ReactElement {
  return <aside className="dtp" data-task-panel aria-label="Task panel" />;
}
