// SPDX-License-Identifier: AGPL-3.0-only
//
// The Executive page (`/dashboard/executive/`, mockup `/agency/executive/`).
// Sections 001 to 004 (the pulse, revenue, the book and client profitability)
// are MP-14-3's and stand in until it lands; 005, what our agents cost us, is
// MP-14-6's and reads for real.

import type { ReactElement } from 'react';
import { InDevelopment } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { AgentCostSection } from './executive/agent-costs.tsx';

export function ExecutiveScreen(props: {
  readonly client: OperationsClient;
  readonly now?: () => number;
}): ReactElement {
  return (
    <section className="page" data-screen="executive">
      <header className="page__head">
        <h1>Executive</h1>
      </header>
      <InDevelopment title="Sections 001 to 004: the pulse, revenue and the book" owner="MP-14-3" />
      <AgentCostSection client={props.client} now={props.now ?? Date.now} />
    </section>
  );
}
