// SPDX-License-Identifier: AGPL-3.0-only
//
// What `model.call` reads from its body, by JSON type, before any authority.
// A present operand of the wrong shape is refused by name, never coerced or
// skipped: a caller that got a default back would believe the broker had read
// what it sent.
//
// A field's `source` is the caller's statement of where it read the value.
// The broker trusts it only to narrow: `business_internal` counts for a cloud
// route only where the operation also declares the field business-internal
// (`effectiveClass`), and every other source keeps the field local.

import type { FieldSource } from '../../../core-connectors/src/index.ts';
import type { ModelCallRequest } from '../../../core-custody/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type Refused } from './outcome.ts';
import type { AgentRequest } from './agent-call.ts';

export type ModelCallOperands = ModelCallRequest;

const SOURCES: ReadonlySet<string> = new Set<FieldSource>([
  'business_internal',
  'client_row',
  'client_person',
  'guest',
  'outside',
]);

const FIXES: readonly string[] = [
  'Send leaseId, stepId and operation as strings, fence as the integer your pickup gave.',
  'Send fields as a list of { name, source, value }, each a string, source one of business_internal, client_row, client_person, guest or outside.',
];

// Named, never echoed: a field's value is prompt content, and a refusal's
// attempted payload is kept in the audit.
const invalid = (name: string): Refused =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [name], FIXES));

function fieldOf(entry: unknown): ModelCallRequest['fields'][number] | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const { name, source, value, ...rest } = entry as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof name !== 'string' || typeof value !== 'string' || typeof source !== 'string') {
    return undefined;
  }
  if (!SOURCES.has(source)) return undefined;
  return { name, source: source as FieldSource, value };
}

export function modelCallOperands(request: AgentRequest): ModelCallOperands | Refused {
  const { leaseId, fence, stepId, operation, fields } = request as Record<string, unknown>;
  // A lease that is not a string names no lease, and is refused by the broker
  // as a made-up one is (`LEASE_NOT_OWNED`), in the same bytes.
  const lease = typeof leaseId === 'string' ? leaseId : '';
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence)) return invalid('fence');
  if (typeof stepId !== 'string') return invalid('stepId');
  if (typeof operation !== 'string') return invalid('operation');
  if (!Array.isArray(fields)) return invalid('fields');
  const parsed: ModelCallRequest['fields'][number][] = [];
  for (const entry of fields) {
    const field = fieldOf(entry);
    if (field === undefined) return invalid('fields');
    parsed.push(field);
  }
  return { leaseId: lease, fence, stepId, operation, fields: parsed };
}
