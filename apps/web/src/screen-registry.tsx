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
import type { AuthenticatedRouteId } from './routes.ts';
import type { OperationsClient } from './operations/client.ts';
import { Projects } from './screens/Projects.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';

/** What the application hands whichever screen the address resolves to. */
export interface ScreenContext {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The route's parameters, decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** Why the board was reached instead of the address that was held. */
  readonly notice: string | null;
  readonly storage: Storage | null;
}

export const SCREENS: Readonly<
  Record<AuthenticatedRouteId, (context: ScreenContext) => ReactElement>
> = {
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
      taskKey={context.params['key'] ?? ''}
    />
  ),
};
