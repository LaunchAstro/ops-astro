// SPDX-License-Identifier: AGPL-3.0-only
//
// What the application draws inside the shell for an address: a screen, a
// public page (C81's legal documents), sign-in, a manifest page's placeholder or refusal, or not-found.

import type { ReactElement } from 'react';
import { BoardEditProvider } from './screens/projects/board-edit-context.tsx';
import { CreateProvider } from './screens/task/create-context.tsx';
import { AssignmentProvider } from './screens/task/assignment-context.tsx';
import { CommentCustodyProvider } from './screens/task/comment-custody-context.tsx';
import { timerFrame } from './screens/task/task-timer-context.tsx';
import { gateOf } from './route-gate.ts';
import type { RouteMatch } from './routes.ts';
import type { PageMatch } from './manifest.ts';
import { ClientRefused, NotFound, PagePlaceholder, SignedInAlready } from './route-views.tsx';
import {
  drawOpenScreen,
  drawScreen,
  type OpenContext,
  type ScreenContext,
} from './screen-registry.tsx';

export function drawContent(props: {
  readonly here: string;
  readonly match: RouteMatch | null;
  readonly at: PageMatch | null;
  readonly signedIn: boolean;
  /** The address names a client the session holds no grant on. */
  readonly refused: boolean;
  readonly signIn: ReactElement;
  /** Where "Go to Projects" goes for a person already signed in. */
  readonly onGo: () => void;
  readonly screen: Omit<ScreenContext, 'params'>;
  /** What a public page reads with: the API's origin and the fetch. */
  readonly open: OpenContext;
}): ReactElement {
  const { match, at } = props;
  // A manifest page with no screen yet: sign-in first, then the grant check.
  if (match === null && at !== null) {
    if (!props.signedIn) return props.signIn;
    return props.refused ? <ClientRefused /> : <PagePlaceholder page={at.page} />;
  }
  const gate = gateOf(match, props.signedIn);
  switch (gate.kind) {
    case 'not-found':
      return <NotFound path={props.here} />;
    case 'sign-in':
      return props.signIn;
    case 'open':
      return drawOpenScreen(gate.match, props.open);
    case 'signed-in-already':
      return <SignedInAlready onGo={props.onGo} />;
    case 'screen':
      return drawScreen(gate.match, props.screen);
  }
}

/** The command custodians outlive page, panel and ordinary authorised rereads. */
export function frameCustody(
  owner: Parameters<typeof timerFrame>[0],
  active: boolean,
  select: (() => void) | null,
  children: ReactElement,
): ReactElement {
  return timerFrame(
    owner,
    active,
    select,
    <AssignmentProvider
      client={owner.client}
      grantKey={owner.grantKey}
      storage={owner.storage ?? null}
    >
      <CreateProvider
        client={owner.client}
        grantKey={owner.grantKey}
        storage={owner.storage ?? null}
      >
        <CommentCustodyProvider
          client={owner.client}
          grantKey={owner.grantKey}
          storage={owner.storage ?? null}
        >
          <BoardEditProvider
            client={owner.client}
            grantKey={owner.grantKey}
            storage={owner.storage ?? null}
          >
            {children}
          </BoardEditProvider>
        </CommentCustodyProvider>
      </CreateProvider>
    </AssignmentProvider>,
  );
}
