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

/** What the application hands whichever screen the address resolves to. */
export interface ScreenContext<Id extends AuthenticatedRouteId = AuthenticatedRouteId> {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The route's parameters, decoded. */
  readonly params: ParamsOf<Id>;
  /** Why the board was reached instead of the address that was held. */
  readonly notice: string | null;
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
  'agency:settings': (context) => (
    <SettingsScreen client={context.client} grantKey={context.grantKey} storage={context.storage} />
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
