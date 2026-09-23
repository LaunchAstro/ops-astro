// SPDX-License-Identifier: AGPL-3.0-only
//
// The commands that are declared, routed, audited — and refuse.
//
// Four of the contract's nine rest on something no part of the ratified split
// builds. `task.comment` was the fifth and is not any more: L2 installed the
// comment record type it was waiting for, so it is a real command with a
// handler and its `waitingOn` text is gone from the declaration. The four
// below keep theirs, and they keep it *unchanged* — the agent's own path, the
// gate triple and the lease table are L4's mechanisms and part B of L3, and a
// placeholder built against interfaces nobody has pinned would be the stub
// this file's last paragraph refuses.
//
// `task.pickup` and `task.handback` need
// the `delegations` and `leases` tables that section 9.1's authority group
// names and that T1c, which built `grants`, did not carry. `task.propose` and
// `task.decide` need the gate triple, and specification 2.1 puts a proposal
// and a decision outside T1 in terms: "T1 does not include a proposal, a
// decision or an effect. It includes the tables and the refusals those things
// will need."
//
// **Why they are here rather than absent.** Every domain operation is
// reachable through an endpoint and the enumeration proving it is generated
// from the exported surface (T1-R7, and T1g's `surface_parity`). A command
// that exists in the contract and not in the surface breaks that enumeration;
// a command in the surface with no route breaks it too. So they are declared,
// they run the whole envelope — the identity is required, the register holds
// the attempt, the audit event is written — and then they refuse with the
// register's own code and name what they wait for.
//
// **Why not a silent success or an empty result.** Anything that is not an
// explicit allow is a refusal, and a stub that returned an empty projection
// would be the exact failure the read-outcome vocabulary exists to prevent: a
// caller cannot tell "there is nothing" from "this was never built".

import type { CommandDeclaration } from './surface.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type Refused } from './outcome.ts';

export function refuseUnlanded(declaration: CommandDeclaration): Refused {
  return refused(
    refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      [declaration.name, declaration.waitingOn],
      [
        'This operation is declared and reachable, and what it rests on has not been built.',
        'It is not a permission problem and retrying will not change it.',
      ],
    ),
  );
}
