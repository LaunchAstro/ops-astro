// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own agents (Assign to AI), spread into `COMMAND_SURFACE` in
// `surface.ts` (kept apart for the line cap). The caller makes one, renames
// one of their own and lists their own. No grant is asked: the handler
// refuses anyone who is not a member of the business, and no agent reaches
// these. Their operands sit here, beside them, for `write-operands.ts`'s line
// cap. Handing a task to an agent is `task.assign`.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const AGENT_COLLECTION = 'agent';

export const OWN_AGENT_SURFACE: readonly CommandDeclaration[] = [
  declare('agent.create', 'write', {
    collection: AGENT_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: [],
    operands: { name: 'any' },
  }),
  declare('agent.rename', 'write', {
    collection: AGENT_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: ['agentId'],
    operands: { agentId: 'id', name: 'any' },
  }),
  read('agent.mine', AGENT_COLLECTION, { authorisedOn: 'self', audited: false }),
];
