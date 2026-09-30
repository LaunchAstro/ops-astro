// SPDX-License-Identifier: AGPL-3.0-only
//
// The screen each authenticated route draws.
//
// The route registry is the router, so the screens are looked up by route id
// rather than chosen by comparing strings. Keyed by `AuthenticatedRouteId`, a
// route added to the registry without a screen here fails the typecheck
// instead of falling through to whichever screen a bare `else` happened to
// draw.

import type { ReactElement } from 'react';
import type { AuthenticatedRouteId, ParamsOf, RouteMatch } from './routes.ts';
import type { OperationsClient } from './operations/client.ts';
import { Projects } from './screens/Projects.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';
import { TaskUnnamed } from './screens/task/Absent.tsx';
import { TodosScreen } from './screens/todos/Todos.tsx';
import type { ConversationTab, PanelDoor } from './screens/task/Perspectives.tsx';

/** The dock task panel as a screen reaches it (MP-4-8): open it, and read its change count. */
export interface TaskPanelHost {
  readonly open: (taskKey: string, door: PanelDoor, tab?: ConversationTab) => void;
  /** Changes made in the panel so far: a screen showing the task reads it again on a new one. */
  readonly changes: number;
}

/** What the application hands whichever screen the address resolves to. */
export interface ScreenContext<Id extends AuthenticatedRouteId = AuthenticatedRouteId> {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The route's parameters, decoded. */
  readonly params: ParamsOf<Id>;
  /** Why the board was reached instead of the address that was held. */
  readonly notice: string | null;
  readonly storage: Storage | null;
  /** Absent where no panel can open, and then a door cannot be pressed. */
  readonly taskPanel?: TaskPanelHost;
}

export const SCREENS: {
  readonly [Id in AuthenticatedRouteId]: (context: ScreenContext<Id>) => ReactElement;
} = {
  'agency:projects-board': (context) => (
    <>
      {context.notice === null ? null : (
        <p className="signin__ended" role="status" data-notice="other-business">
          {context.notice}
        </p>
      )}
      <Projects
        client={context.client}
        grantKey={context.grantKey}
        {...(context.taskPanel === undefined
          ? {}
          : {
              onOpen: (key: string) => {
                context.taskPanel?.open(key, 'open');
              },
              changes: context.taskPanel.changes,
            })}
      />
    </>
  ),
  'agency:settings': (context) => (
    <SettingsScreen client={context.client} grantKey={context.grantKey} storage={context.storage} />
  ),
  'agency:task-detail': (context) => (
    <TaskDetailScreen
      client={context.client}
      grantKey={context.grantKey}
      taskKey={context.params.key}
      {...(context.taskPanel === undefined
        ? {}
        : {
            onOpenPanel: (door: PanelDoor, tab?: ConversationTab) => {
              context.taskPanel?.open(context.params.key, door, tab);
            },
            changes: context.taskPanel.changes,
          })}
    />
  ),
  'agency:task-unnamed': () => <TaskUnnamed />,
  'agency:todos': (context) => (
    <TodosScreen
      client={context.client}
      grantKey={context.grantKey}
      {...(context.taskPanel === undefined
        ? {}
        : {
            onOpen: (key: string) => {
              context.taskPanel?.open(key, 'open');
            },
            changes: context.taskPanel.changes,
          })}
    />
  ),
};

/** The screen a matched address draws, handed that route's own parameters. */
export function drawScreen<Id extends AuthenticatedRouteId>(
  match: RouteMatch<Id>,
  context: Omit<ScreenContext<Id>, 'params'>,
): ReactElement {
  return SCREENS[match.id]({ ...context, params: match.params });
}
