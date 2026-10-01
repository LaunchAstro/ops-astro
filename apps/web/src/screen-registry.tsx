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

import type { ReactElement, ReactNode } from 'react';
import { Gallery } from '@launchastro/ui';
import type { AuthenticatedRouteId, OpenRouteId, ParamsOf, RouteMatch } from './routes.ts';
import type { OperationsClient } from './operations/client.ts';
import { AccessScreen } from './screens/Access.tsx';
import { LegalScreen } from './screens/Legal.tsx';
import { OperationsScreen } from './screens/Operations.tsx';
import { Projects } from './screens/Projects.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { OwnSessions } from './screens/settings/sessions.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';
import { TelemetryScreen } from './screens/Telemetry.tsx';

/** What the application hands whichever screen the address resolves to. */
export interface ScreenContext<Id extends AuthenticatedRouteId = AuthenticatedRouteId> {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The route's parameters, decoded. */
  readonly params: ParamsOf<Id>;
  /** Why the board was reached instead of the address that was held. */
  readonly notice: ReactNode;
  readonly storage: Storage | null;
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
      <Projects client={context.client} grantKey={context.grantKey} />
    </>
  ),
  'agency:gallery': () => <Gallery />,
  // Settings ▸ General, then the person's own sessions (C58), which post to
  // their own account routes rather than to the settings commands.
  'agency:settings': (context) => (
    <>
      <SettingsScreen
        client={context.client}
        grantKey={context.grantKey}
        storage={context.storage}
      />
      <OwnSessions client={context.client} grantKey={context.grantKey} />
    </>
  ),
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
      fetch={context.fetch}
    />
  ),
};

export function drawOpenScreen(match: RouteMatch<OpenRouteId>, context: OpenContext): ReactElement {
  return OPEN_SCREENS[match.id](match.params, context);
}
