// SPDX-License-Identifier: AGPL-3.0-only
//
// The screen each authenticated route draws.
//
// The route registry is the router, so the screens are looked up by route id
// rather than chosen by comparing strings. Keyed by `AuthenticatedRouteId`, a
// route added to the registry without a screen here fails the typecheck
// instead of falling through to whichever screen a bare `else` happened to
// draw.

import type { ReactElement, ReactNode } from 'react';
import { Gallery } from '@launchastro/ui';
import type { AuthenticatedRouteId, ParamsOf, RouteMatch } from './routes.ts';
import type { OperationsClient } from './operations/client.ts';
import { AccessScreen } from './screens/Access.tsx';
import { InboxScreen } from './screens/Inbox.tsx';
import { Projects } from './screens/Projects.tsx';
import { SettingsGeneralScreen } from './screens/SettingsGeneral.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';
import { TaskUnnamed } from './screens/task/Absent.tsx';
import { TodosScreen } from './screens/todos/Todos.tsx';
import { TeamScreen } from './screens/Team.tsx';
import { TelemetryScreen } from './screens/Telemetry.tsx';
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
  readonly notice: ReactNode;
  readonly storage: Storage | null;
  /** Absent where no panel can open, and then a door cannot be pressed. */
  readonly taskPanel?: TaskPanelHost;
  /** Goes to an address inside the application. */
  readonly navigate: (path: string) => void;
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
        navigate={context.navigate}
        {...(context.taskPanel === undefined ? {} : { taskPanel: context.taskPanel })}
      />
    </>
  ),
  'agency:gallery': () => <Gallery />,
  'agency:settings': (context) => (
    <SettingsGeneralScreen
      client={context.client}
      grantKey={context.grantKey}
      storage={context.storage}
    />
  ),
  'agency:inbox': (context) => (
    <InboxScreen client={context.client} grantKey={context.grantKey} navigate={context.navigate} />
  ),
  'agency:team': (context) => <TeamScreen client={context.client} grantKey={context.grantKey} />,
  'agency:access': (context) => (
    <AccessScreen client={context.client} grantKey={context.grantKey} />
  ),
  'agency:telemetry': (context) => (
    <TelemetryScreen client={context.client} grantKey={context.grantKey} />
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
