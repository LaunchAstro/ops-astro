// SPDX-License-Identifier: AGPL-3.0-only
//
// The commands that are declared, routed, audited — and refuse.
//
// No declared operation waits on anything now. Four of the contract's nine
// once did, and `task.comment` was a fifth: `task.pickup` and `task.handback`
// waited on the `delegations` and `leases` tables, `task.propose` and
// `task.decide` on the gate triple, and `task.comment` on the comment record
// type. All five have landed as real commands with handlers, and no
// declaration in `surface.ts` passes a `waitingOn` any more, so `landed` is
// true across the surface. What remains here is `refuseUnlanded` itself,
// which `tasks-comment.ts` still calls for a business whose comment record
// type is not installed, and the reasons below, which apply to any operation
// declared before what it rests on is built.
//
// **Why they are here rather than absent.** Every domain operation is
// reachable through an endpoint and the enumeration proving it is generated
// from the exported surface (T1-R7, `tests/acceptance/surface-inventory.test.ts`). A command
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
