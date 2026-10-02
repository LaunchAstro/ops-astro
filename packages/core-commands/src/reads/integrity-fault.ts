// SPDX-License-Identifier: AGPL-3.0-only
//
// The fault a read raises when its stored decisions do not verify. Re-exported
// by `dispatch.ts`, where every read runs.

import type { DecisionIntegrityError } from './verified-decisions.ts';

/**
 * A read whose stored decisions did not verify, answered as the fault it is.
 *
 * Not a refusal: nothing the caller sent was wrong and nothing they can change
 * will make it pass, so it carries no `refused` flag and no register code's
 * status. Not `SERVICE_UNAVAILABLE` either, whose fix is "retry": a tampered
 * or incomplete chain answers the same way every time until an operator looks
 * at it. So it has its own code, `DECISION_INTEGRITY`, under 500.
 *
 * The body carries the code and fixed words only. Where the chain broke --
 * a sequence number, a key id, a gate -- stays in `message` for the server's
 * log, because the body is shown to whoever asked and a stored value in it
 * tells a prober what the database holds.
 *
 * The transaction ends with the throw, so the read's audit row is rolled back
 * with everything else in it and none is written. Nothing is repaired either:
 * the stored rows are the evidence and stay as they were found.
 *
 * `getResponse` is the shape Hono's error handler answers with, which is how
 * the fault reaches HTTP without the read knowing about the transport.
 */
export class ReadIntegrityFault extends Error {
  readonly code = 'DECISION_INTEGRITY';
  readonly status = 500;

  constructor(cause: DecisionIntegrityError) {
    super(cause.message, { cause });
    this.name = 'ReadIntegrityFault';
  }

  getResponse(): Response {
    return Response.json(
      { code: this.code, names: [], fixes: INTEGRITY_FIXES },
      { status: this.status },
    );
  }
}

const INTEGRITY_FIXES: readonly string[] = [
  'The stored decisions on this task did not verify, so none of it was shown.',
  'Nothing was changed. Retrying will give the same answer; report it to the operator.',
];
