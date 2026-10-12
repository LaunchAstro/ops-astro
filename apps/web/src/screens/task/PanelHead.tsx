// SPDX-License-Identifier: AGPL-3.0-only
import { Icon, usePanelToolbar } from '@launchastro/ui';
import { createPortal } from 'react-dom';
import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';
import { taskContext, type PageContext } from './task-prefill.ts';
import { PanelName } from './PanelFields.tsx';
import { AskDoor } from './PanelAgent.tsx';
import { TaskPin, TaskPinsNotice } from './task-pins-context.tsx';
import { PanelBoardDoor } from './board-door.tsx';

interface PanelHeadProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly grantKey: string;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly docked?: boolean;
  readonly onNewTask?: ((page: PageContext) => void) | undefined;
}

export function PanelHead(props: PanelHeadProps): ReactElement {
  const { task, onNewTask } = props;
  const toolbar = usePanelToolbar();
  return (
    <div className="dtp__head">
      <h2 className="t-title" data-panel-title>
        <PanelName client={props.client} task={task} onChanged={props.onChanged} />
      </h2>
      <AskDoor grantKey={props.grantKey} task={task} />
      <TaskPin taskId={task.id} />
      {toolbar === null ? (
        <PanelDoors task={task} onNewTask={onNewTask} />
      ) : (
        createPortal(
          <>
            <button
              className="dpanel__btn"
              type="button"
              data-panel-head="new"
              aria-label="New task"
              title="New task"
              disabled={onNewTask === undefined}
              onClick={() => onNewTask?.(taskContext(task))}
            >
              <Icon name="plus" />
            </button>
            <PanelBoardDoor task={task} compact />
          </>,
          toolbar,
        )
      )}
      <TaskPinsNotice />
      {props.docked === true ? null : (
        <button className="btn" type="button" data-panel-head="close" onClick={props.onClose}>
          Close
        </button>
      )}
    </div>
  );
}

function PanelDoors({ task, onNewTask }: Pick<PanelHeadProps, 'task' | 'onNewTask'>): ReactElement {
  return (
    <div className="dtp__doors">
      <button
        className="btn"
        type="button"
        data-panel-head="new"
        disabled={onNewTask === undefined}
        onClick={() => onNewTask?.(taskContext(task))}
      >
        New task
      </button>
      <a
        className="btn"
        data-panel-head="page"
        href={pathTo('agency:task-detail', { key: task.key })}
      >
        Open its page
      </a>
      <PanelBoardDoor task={task} />
    </div>
  );
}
