// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock the frame draws: the panel registry's tabs, the Notifications
// tab's owed figure (MP-7-3 bell count at load), and what a press does. The
// client face has no dock (R17). An open tab is announced as "Close", so
// pressing it leaves the address for the board rather than pushing the same
// address again.

import { useOwedCount } from './data/owed-count.ts';
import type { OperationsClient } from './operations/client.ts';
import { PANELS, dockTabs } from './panels.ts';
import { pathTo } from './routes.ts';
import type { Session } from './session/token.ts';

export function useDock(options: {
  readonly client: OperationsClient;
  readonly session: Session | null;
  readonly agency: boolean;
  readonly here: string;
  readonly navigate: (path: string) => void;
}): { tabs: ReturnType<typeof dockTabs>; press: (id: string) => void } {
  const { client, session, agency, here, navigate } = options;
  const shown = session !== null && agency;
  const owed = useOwedCount(client, session, shown);
  return {
    tabs: shown ? dockTabs(here, { notifications: owed }) : [],
    press: (id) => {
      const panel = PANELS.find((entry) => entry.id === id);
      if (panel === undefined || panel.route === null) return;
      const target = pathTo(panel.route);
      navigate(here === target ? pathTo('agency:projects-board') : target);
    },
  };
}
