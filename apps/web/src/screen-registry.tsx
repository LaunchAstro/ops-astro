// SPDX-License-Identifier: AGPL-3.0-only
//
// The screen each authenticated route draws, and each open one (a public
// route other than sign-in, drawn from public reads with or without a session).
//
// The route registry is the router, so the screens are looked up by route id
// rather than chosen by comparing strings. Keyed by `AuthenticatedRouteId`, a
// route added to the registry without a screen here fails the typecheck
// instead of falling through to whichever screen a bare `else` happened to
// draw.

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Gallery } from '@launchastro/ui';
import { clientNamedIn } from './client-address.ts';
import {
  type AuthenticatedRouteId,
  type OpenRouteId,
  type ParamsOf,
  type RouteMatch,
} from './routes.ts';
import type { PanelId } from './panels.ts';
import { tabRollupFloor } from './data/rollup-floor.ts';
import type { OperationsClient } from './operations/client.ts';
import { ConnectionsScreen } from './screens/Connections.tsx';
import { ConversationScreen } from './screens/Conversation.tsx';
import { AccessScreen } from './screens/Access.tsx';
import { ClientsScreen } from './screens/Clients.tsx';
import { InboxScreen } from './screens/Inbox.tsx';
import { LegalScreen } from './screens/Legal.tsx';
import { OperationsScreen } from './screens/Operations.tsx';
import { Projects } from './screens/Projects.tsx';
import { SettingsGeneralScreen } from './screens/SettingsGeneral.tsx';
import { AuthenticatorSetup } from './screens/settings/authenticator.tsx';
import { OwnSessions } from './screens/settings/sessions.tsx';
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
  /** The whole address the screen is drawn at, query included: the page's, or a panel's place. */
  readonly address?: string;
  /** True where the screen is drawn in a dock panel: the page's address is then not its to write. */
  readonly inPanel?: boolean;
  /**
   * Opens a dock panel at a place by the gesture law (MP-3-4): false where
   * that panel has no tab, and absent where there is no dock.
   */
  readonly openPanel?: (id: PanelId, beside: boolean, place: string) => boolean;
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
        {...(context.address === undefined ? {} : { address: context.address })}
        inPanel={context.inPanel === true}
      />
    </>
  ),
  'agency:agent-conversation': (context) => (
    <ConversationScreen
      client={context.client}
      grantKey={context.grantKey}
      conversationId={context.params.conversation}
    />
  ),
  // Keyed on the grant, so a change of business or person, or a sign-out (the
  // key's generation), starts the fleet's view state, open rows and repair
  // attempts over; a step-up keeps the reader, as `grantKeyOf` does everywhere.
  // An agency-wide rollup, so it re-reads on the tab's floor (LIVE-SYNC.md).
  'agency:connections': (context) => (
    <ConnectionsScreen
      key={context.grantKey}
      client={context.client}
      grantKey={context.grantKey}
      rollup={tabRollupFloor()}
    />
  ),
  'agency:gallery': () => <Gallery />,
  // Settings ▸ General, then the person's own sessions (C58) and authenticator app (C59),
  // which post to their own account routes rather than to the settings commands.
  'agency:settings': (context) => (
    <>
      <SettingsGeneralScreen
        client={context.client}
        grantKey={context.grantKey}
        storage={context.storage}
      />
      <OwnSessions client={context.client} grantKey={context.grantKey} />
      <AuthenticatorSetup key={context.grantKey} client={context.client} />
    </>
  ),
  'agency:inbox': (context) => (
    <InboxScreen
      client={context.client}
      grantKey={context.grantKey}
      navigate={context.navigate}
      {...(context.openPanel === undefined ? {} : { openPanel: context.openPanel })}
    />
  ),
  'agency:clients': (context) => (
    <ClientsScreen
      client={context.client}
      grantKey={context.grantKey}
      at={clientNamedIn(context.address)}
    />
  ),
  'agency:team': (context) => <TeamScreen client={context.client} grantKey={context.grantKey} />,
  'agency:access': (context) => (
    <AccessScreen client={context.client} grantKey={context.grantKey} />
  ),
  'agency:telemetry': (context) => (
    <TelemetryScreen client={context.client} grantKey={context.grantKey} />
  ),
  'agency:operations': (context) => (
    <OperationsScreen client={context.client} grantKey={context.grantKey} />
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

/**
 * The screen a matched address draws, handed that route's own parameters.
 * Keyed on the grant: a screen's own state (a typed proposal, an outcome line)
 * was made under one business and person, so a switch that keeps the same
 * address, in the page or a dock panel, draws the screen afresh (#487).
 */
export function drawScreen<Id extends AuthenticatedRouteId>(
  match: RouteMatch<Id>,
  context: Omit<ScreenContext<Id>, 'params'>,
): ReactElement {
  return (
    <Fragment key={context.grantKey}>
      {SCREENS[match.id]({ ...context, params: match.params })}
    </Fragment>
  );
}

/** What an open route's screen is handed: the public reads only, never the session's client. */
export interface OpenContext {
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

/** The screen each open route draws, with or without a session; keyed so none is missed. */
const OPEN_SCREENS: {
  readonly [Id in OpenRouteId]: (params: ParamsOf<Id>, context: OpenContext) => ReactElement;
} = {
  'agency:legal': (params, context) => (
    <LegalScreen
      key={`${params.business}/${params.document}`}
      business={params.business}
      document={params.document}
      apiOrigin={context.apiOrigin}
      read={context.fetch}
    />
  ),
};

export function drawOpenScreen(match: RouteMatch<OpenRouteId>, context: OpenContext): ReactElement {
  return OPEN_SCREENS[match.id](match.params, context);
}
