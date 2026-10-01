// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock the frame draws: the panel registry's tabs, the Notifications
// tab's owed figure (MP-7-3 bell count at load), and what a press does. The
// client face has no dock (R17). An open tab is announced as "Close", so
// pressing it leaves the address for the board rather than pushing the same
// address again.

import { useOwedCount } from './data/owed-count.ts';
import type { OperationsClient } from './operations/client.ts';
import { dockTabs, dockTarget } from './panels.ts';
import type { Session } from './session/token.ts';

export function useDock(options: {
  readonly client: OperationsClient;
  readonly session: Session | null;
  readonly agency: boolean;
  readonly here: string;
  readonly navigate: (path: string) => void;
  /** The Agent drawer (MP-7-11): open over the page, toggled by its tab. */
  readonly agent: { readonly open: boolean; readonly toggle: () => void };
}): { tabs: ReturnType<typeof dockTabs>; press: (id: string) => void } {
  const { client, session, agency, here, navigate, agent } = options;
  const shown = session !== null && agency;
  const owed = useOwedCount(client, session, shown);
  return {
    tabs: shown ? dockTabs(here, { notifications: owed }, agent.open) : [],
    press: (id) => {
      const target = dockTarget(id, here);
      if (target === 'agent') agent.toggle();
      else if (target !== null) navigate(target);
    },
  };
}
