// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register's launch rows (AW-08), split out of `register.ts` by
// ticket to keep it under the product file limit. `register.ts` spreads them
// after its tail, so the rows before them keep their order.

export const LAUNCH_ROWS = [
  // Dispatch releases an effect only for a reviewed output's launch: the plan
  // accept lets work run and fires nothing (`core-runtime/src/reviewed-output.ts`).
  {
    code: 'LAUNCH_NOT_DECIDED',
    status: 409,
    meaning: 'The work was approved as a plan, not launched from its reviewed output',
    source: 'AW-08',
    runtime: true,
  },
  // Where the business requires the client's sign-off, agency approval alone
  // releases nothing: the launch and dispatch both refuse (`launch-gate.ts`).
  {
    code: 'CLIENT_SIGNOFF_REQUIRED',
    status: 409,
    meaning: 'The business requires the client’s sign-off before this effect goes out',
    source: 'AW-08',
    runtime: true,
  },
  // Launch from the task: a person opens a run for the task's agent
  // (`authority/launches.ts`). Each refusal writes nothing.
  {
    code: 'LAUNCH_NO_AGENT',
    status: 409,
    meaning: 'This task is not assigned to an AI agent, so there is nothing to launch',
    source: 'Launch from the task',
  },
  {
    code: 'LAUNCH_CLIENT_TASK',
    status: 409,
    meaning: 'Only internal tasks go to an AI agent for now, and this task belongs to a client',
    source: 'Launch from the task, owner ruling 11 Oct',
  },
  {
    code: 'AGENT_NOT_ACTIVE',
    status: 409,
    meaning: 'The agent holding this task has been switched off',
    source: 'Launch from the task',
  },
  {
    code: 'RUN_ALREADY_OPEN',
    status: 409,
    meaning: 'A run of this task is already open',
    source: 'Launch from the task',
  },
] as const;
