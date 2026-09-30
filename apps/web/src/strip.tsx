// SPDX-License-Identifier: AGPL-3.0-only
//
// The app strip as the application wires it: Back and Forward (MP-2-5), the
// client's identity and the face switch (MP-2-4), search (C1) and the person
// menu (C23).

import type { ReactElement, Ref } from 'react';
import { AppStrip, PersonMenu, type StripClient, type StripSteps } from '@launchastro/ui';
import { pathTo } from './routes.ts';
import type { Session } from './session/token.ts';

export function FrameStrip(props: {
  readonly face: 'agency' | 'client';
  readonly identity: StripClient | null;
  /** The client the address names; the switch is drawn only with its identity. */
  readonly clientSlug: string | null;
  readonly steps: StripSteps | undefined;
  readonly onSearch: (() => void) | null;
  readonly searchRef: Ref<HTMLButtonElement>;
  readonly session: Session | null;
  readonly personName: string | null;
  readonly navigate: (path: string) => void;
  readonly onSignOut: () => void;
}): ReactElement {
  const { clientSlug, navigate, session } = props;
  return (
    <AppStrip
      face={props.face}
      client={props.identity}
      {...(props.steps === undefined ? {} : { steps: props.steps })}
      onSearch={props.onSearch}
      searchRef={props.searchRef}
      onFace={
        props.identity === null || clientSlug === null
          ? null
          : (next) => {
              navigate(next === 'client' ? `/portal/${clientSlug}/` : `/clients/${clientSlug}/`);
            }
      }
    >
      {session === null ? null : (
        <PersonMenu
          name={props.personName}
          email={session.email}
          settingsHref={pathTo('agency:settings')}
          onSettings={() => {
            navigate(pathTo('agency:settings'));
          }}
          onSignOut={props.onSignOut}
        />
      )}
    </AppStrip>
  );
}
