// SPDX-License-Identifier: AGPL-3.0-only
//
// The register's view of a request (`envelope.ts`): what two attempts under
// one operation id are compared on.

import type { UncheckedRequest } from './requests.ts';

/**
 * The part of a request the register compares, which is everything except the
 * identity itself. Two requests differing only in their `operation_id` are two
 * attempts, not a conflict; two differing anywhere else under one identity are
 * the conflict `OPERATION_ID_REUSED` names.
 */
export function comparablePayload(request: UncheckedRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
}
