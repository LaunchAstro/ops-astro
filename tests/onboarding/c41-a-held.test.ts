// SPDX-License-Identifier: AGPL-3.0-only
//
// C41-A's named tests that wait on work not built on this branch (U38, #495).
// Each is held by name, with what it waits on, and becomes a real case when
// that work lands; none is dropped.

import { describe, it } from 'vitest';

describe('C41-A held until the work it leans on lands', () => {
  // The run (`run started`, `run state changed`): `run:write` is defined once,
  // by SL12-B-2 (U37), and the agent run engine is AW-01 (SL11, U100).
  it.todo(
    'C41-A owner check: the first agent step runs and stops at its first approval (run:write, AW-01)',
  );
  it.todo('C41-A refusal run:write: without it no onboarding run starts (run:write, SL12-B-2)');

  // The person and client-wait steps' inbox raise is `c41-a-inbox-raise.test.ts`.
  // The agent step parks at its run's approval gate, whose decision item the
  // gate raises: it waits on the run start (AW-04's accept, via b0/SL12).
  it.todo(
    'CS-15.4 the agent step parks at its approval gate with a decision item to whoever decides it (run start, AW-04)',
  );

  // The client email (`draft email created`) and its one send path are AW-07b
  // (SL12, U35).
  it.todo('C41-A refusal inbox:write: without it no client email is drafted (inbox:write, AW-07b)');
  it.todo(
    'C41-A send through AW-07b: the drafted email leaves only through the send adapter, and no other send path exists',
  );
  it.todo(
    'C41-A canary: drafted client email content never reaches logs, errors, traces or the audit payload (AW-07b)',
  );

  // The first-client gate and the command catalogue's data class are S0-5
  // (U18) over API-1's catalogue.
  it.todo(
    'C41-A gate refusal: with the readiness check false each client-data write is refused in plain words and writes nothing (S0-5)',
  );

  // The look: the component and page kits and the width-and-theme harness.
  it.todo(
    'C41-A look: Start onboarding built from the kits at 1480, 900 and 390, light and dark (MP-1-3, MP-9-1, MP-1-7)',
  );
});
