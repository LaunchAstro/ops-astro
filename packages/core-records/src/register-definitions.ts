// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register's definition rows, split out of `register.ts` by
// ticket to keep it under the product file limit: AW-02's instruction-file
// codes and AW-01 J's occurrence-run codes. `register.ts` spreads them in
// place, so the register's order, types and wire answers are unchanged.

export const DEFINITION_ROWS = [
  // Instruction files pinned by digest (AW-02, `core-runtime/src/definitions.ts`).
  {
    code: 'ACTIVATION_MODE_NOT_PERMITTED',
    status: 403,
    meaning: 'An instruction file has no activation modes: only a person activates it, by hand',
    source: 'AW-02, automations contract E4',
    runtime: true,
  },
  {
    code: 'DELEGATION_EXCLUDES_ACTIVATION',
    status: 403,
    meaning: 'An agent never activates an instruction file, in any mode',
    source: 'AW-02, automations contract 3.3',
    runtime: true,
  },
  {
    code: 'DEFINITION_DIGEST_MISMATCH',
    status: 409,
    meaning: "The file's bytes are not the ones the run pinned; a changed file is a new file",
    source: 'AW-02, automations contract 5.1',
    runtime: true,
  },
  {
    code: 'DEFINITION_UNAVAILABLE',
    status: 409,
    meaning: 'The pinned instruction file cannot be read at its exact identity',
    source: 'AW-02, automations contract 5.1',
    runtime: true,
  },
  // AW-01 J: an automation occurrence's run, the worker's system write
  // (`core-commands/src/commands/occurrence-run.ts`). Each writes nothing.
  {
    code: 'OCCURRENCE_UNKNOWN',
    status: 404,
    meaning: 'No occurrence by that id is waiting for a run in this business',
    source: 'AW-01 J, C33 occurrence records',
    runtime: true,
  },
  {
    code: 'WORKER_REQUIRED',
    status: 403,
    meaning:
      "An occurrence's run is written by an active worker of this business, never a person or an agent",
    source: 'AW-01 J, capability slices: system writes run under a worker lease',
    runtime: true,
  },
  {
    code: 'APPROVAL_NOT_STANDING',
    status: 409,
    meaning:
      "The occurrence's standing approval was revoked, ended or superseded, so it starts no run",
    source: 'AW-01 J, C52-A revocation checked at dispatch',
    runtime: true,
  },
  {
    code: 'DEFINITION_REVOKED',
    status: 409,
    meaning: 'The definition version the activation pins was revoked, so it starts no run',
    source: 'AW-01 J, automations contract 4.3',
    runtime: true,
  },
] as const;

/** The same codes' place on the register's list of codes nothing produces yet. */
export const UNPRODUCED_DEFINITION_CODES = [
  // AW-02's four. The pinned-file stores are built, and their one entry point
  // is AW-04's plan accept, which activates a file and starts the run that
  // reads it; each comes off this list with that accept.
  'ACTIVATION_MODE_NOT_PERMITTED',
  'DEFINITION_DIGEST_MISMATCH',
  'DEFINITION_UNAVAILABLE',
  'DELEGATION_EXCLUDES_ACTIVATION',
  // AW-01 J's four. The occurrence run is the worker's system write, never a
  // command; C52-A's dispatch (U36) is its one caller, and each comes off this
  // list with that dispatch.
  'OCCURRENCE_UNKNOWN',
  'WORKER_REQUIRED',
  'APPROVAL_NOT_STANDING',
  'DEFINITION_REVOKED',
] as const;
