// SPDX-License-Identifier: AGPL-3.0-only
//
// The Executive page (`/dashboard/executive/`, mockup `/agency/executive/`).
// Sections 001 to 004 (the pulse, revenue, the book and client profitability)
// are MP-14-3's and stand in until it lands; 005, what our agents cost us, is
// MP-14-6's and reads for real.

import type { ReactElement } from 'react';
import { InDevelopment } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import { AgentCostSection } from './executive/agent-costs.tsx';

export function ExecutiveScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly now?: () => number;
  readonly rollup?: RollupFloor;
}): ReactElement {
  return (
    <div className="secs" data-screen="executive">
      <InDevelopment title="Sections 001 to 004: the pulse, revenue and the book" owner="MP-14-3" />
      <AgentCostSection
        client={props.client}
        grantKey={props.grantKey}
        now={props.now ?? Date.now}
        {...(props.rollup === undefined ? {} : { rollup: props.rollup })}
      />
    </div>
  );
}
