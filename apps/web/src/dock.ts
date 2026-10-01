// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock the frame draws: the panel registry's tabs, the Notifications
// tab's owed figure (MP-7-3 bell count at load), and what a press does. The
// client face has no dock (R17). An open tab is announced as "Close", so
// pressing it leaves the address for the board rather than pushing the same
// address again. The Agent tab (MP-7-11) toggles its drawer over the page.

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
  readonly agentOpen: boolean;
  readonly onAgent: () => void;
}): { tabs: ReturnType<typeof dockTabs>; press: (id: string) => void } {
  const { client, session, agency, here, navigate, agentOpen, onAgent } = options;
  const shown = session !== null && agency;
  const owed = useOwedCount(client, session, shown);
  return {
    tabs: shown ? dockTabs(here, { notifications: owed }, agentOpen) : [],
    press: (id) => {
      const target = dockTarget(id, here);
      if (target === 'agent') onAgent();
      else if (target !== null) navigate(target);
    },
  };
}
