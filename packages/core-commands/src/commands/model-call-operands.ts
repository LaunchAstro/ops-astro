// SPDX-License-Identifier: AGPL-3.0-only
//
// What `model.call` reads from its body, by JSON type, before any authority.
// A present operand of the wrong shape is refused by name, never coerced or
// skipped: a caller that got a default back would believe the broker had read
// what it sent.
//
// A field is either supplied, `{ name, source, value }`, where `source` is
// the caller's statement of where it read the value and only narrows (a
// claimed `business_internal` counts as `outside`, S3), or bound to its row,
// `{ name, from: { recordId, key } }`, where the broker reads the value and
// finds the source itself. Only a bound field can reach a cloud route.

import type { FieldSource } from '../../../core-connectors/src/index.ts';
import type { ModelCallRequest } from '../../../core-custody/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type Refused } from './outcome.ts';
import type { AgentRequest } from './agent-call.ts';

/** The call as the body names it. The step is the lease's own attempt's, read under the lease. */
export type ModelCallOperands = Omit<ModelCallRequest, 'stepId'>;

const SOURCES: ReadonlySet<string> = new Set<FieldSource>([
  'business_internal',
  'client_row',
  'client_person',
  'guest',
  'outside',
]);

const FIXES: readonly string[] = [
  'Send leaseId and operation as strings, fence as the integer your pickup gave.',
  'Send fields as a list of { name, source, value }, each a string, source one of business_internal, client_row, client_person, guest or outside, or of { name, from: { recordId, key } } to bind a field to its row.',
];

// Named, never echoed: a field's value is prompt content, and a refusal's
// attempted payload is kept in the audit.
const invalid = (name: string): Refused =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [name], FIXES));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `{ name, from: { recordId, key } }`, each a string and nothing else. */
function boundOf(entry: Record<string, unknown>): ModelCallRequest['fields'][number] | undefined {
  const { name, from, ...rest } = entry;
  if (Object.keys(rest).length > 0 || typeof name !== 'string' || !isObject(from)) return undefined;
  const { recordId, key, ...extra } = from;
  if (Object.keys(extra).length > 0 || typeof recordId !== 'string' || typeof key !== 'string') {
    return undefined;
  }
  return { name, from: { recordId, key } };
}

function fieldOf(entry: unknown): ModelCallRequest['fields'][number] | undefined {
  if (!isObject(entry)) return undefined;
  if (Object.hasOwn(entry, 'from')) return boundOf(entry);
  const { name, source, value, ...rest } = entry;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof name !== 'string' || typeof value !== 'string' || typeof source !== 'string') {
    return undefined;
  }
  if (!SOURCES.has(source)) return undefined;
  return { name, source: source as FieldSource, value };
}

export function modelCallOperands(request: AgentRequest): ModelCallOperands | Refused {
  const { leaseId, fence, operation, fields } = request as Record<string, unknown>;
  // A lease that is not a string names no lease, and is refused by the broker
  // as a made-up one is (`LEASE_NOT_OWNED`), in the same bytes.
  const lease = typeof leaseId === 'string' ? leaseId : '';
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence)) return invalid('fence');
  if (typeof operation !== 'string') return invalid('operation');
  if (!Array.isArray(fields)) return invalid('fields');
  const parsed: ModelCallRequest['fields'][number][] = [];
  for (const entry of fields) {
    const field = fieldOf(entry);
    if (field === undefined) return invalid('fields');
    parsed.push(field);
  }
  return { leaseId: lease, fence, operation, fields: parsed };
}
