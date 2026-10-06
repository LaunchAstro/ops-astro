// SPDX-License-Identifier: AGPL-3.0-only
//
// Receipt L records what one live correction did; Receipt LP is the pilot's
// and is what a later claim cites (release decision section 7). An
// observation may only be filled by looking at the real thing: a blank value
// or a value the plan supplied is empty. An unknown stays unknown and is never
// a pass through the absence of a complaint.

export const RECEIPT_L_OBSERVATIONS = [
  'pre_image_digest',
  'approved_version_digest',
  'gate_decision',
  'published_diff',
  'drift_comparison',
  'published_revision',
  'deployment_served',
  'post_live_address',
  'after_capture',
  'before_capture',
  'decoy_unchanged',
  'stylesheets_unchanged',
  'attempt_and_dispatch_token',
  'refusals_raised',
  'unknown_outcome_reconciliation',
] as const;

export type ReceiptLField = (typeof RECEIPT_L_OBSERVATIONS)[number];

export interface Observation {
  readonly observed: string;
}

export type ReceiptLObservations = Readonly<Record<ReceiptLField, Observation>>;

export const ACCEPTANCE_CASES = [
  { id: 1, name: 'The correction goes live' },
  { id: 2, name: 'Nothing else moved' },
  { id: 3, name: 'The approval and the published bytes are the same state of the world' },
  { id: 4, name: 'A stale decision at dispatch is refused' },
  { id: 5, name: 'Drifted content refuses rather than publishing the newer bytes' },
  { id: 6, name: 'An unknown publish outcome stays unknown' },
  { id: 7, name: 'A cancellation arriving after dispatch produces an unknown, not a cancellation' },
  { id: 8, name: 'The reversal works, on the live site, and is timed' },
  { id: 9, name: 'The envelope refuses' },
] as const;

export type PreconditionKind = 'gate' | 'calibration' | 'not_a_condition';

export const PRECONDITIONS: readonly {
  readonly id: number;
  readonly kind: PreconditionKind;
  readonly text: string;
}[] = [
  { id: 1, kind: 'gate', text: 'Receipt P filled on the permanent public repository' },
  {
    id: 2,
    kind: 'gate',
    text: 'P6 accepted: the coherent local task demo on real local persistence',
  },
  { id: 3, kind: 'gate', text: 'P7 accepted: bounded agent work' },
  { id: 4, kind: 'gate', text: 'custody conformance green' },
  { id: 5, kind: 'gate', text: 'egress conformance green' },
  { id: 6, kind: 'gate', text: 'the six operations registered with all twelve declarations' },
  { id: 7, kind: 'gate', text: 'the email slice landed, with its batch rule' },
  { id: 8, kind: 'gate', text: 'capture and the review proxy under the C18-1 fence' },
  { id: 9, kind: 'gate', text: 'the change envelope enforced as a refusal, the refusal observed' },
  {
    id: 10,
    kind: 'gate',
    text: 'the pre-image digest pinned before the proposal, the drift check against it',
  },
  { id: 11, kind: 'gate', text: 'the production gate conditions applied' },
  {
    id: 12,
    kind: 'gate',
    text: 'the four protected components on the path with conformance proofs green',
  },
  {
    id: 13,
    kind: 'not_a_condition',
    text: 'the external security audit (a condition before version 1.0)',
  },
  { id: 14, kind: 'calibration', text: 'the layered-catch result' },
  { id: 15, kind: 'calibration', text: 'a rehearsal against a non-live copy of the site' },
];

/** Release decision section 9: what stays held after success. */
export const STAYS_HELD: readonly string[] = [
  'A second correction of the same shape is permitted under the same gate; any change of kind is a new decision.',
  'The grant does not widen on success; a relaxation of merge policy is a recorded decision with a named condition.',
  'No unattended publishing: a correction that reached nobody stops, and nothing may release one by default.',
  'Client sites and client personal information.',
  'Campaign execution.',
  'Version 1.0 and adopter installation.',
  'Authenticated capture, and any credential reaching a browser process.',
  'Arbitrary execution and the sandbox.',
];

function filled(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const observed = (value as Record<string, unknown>)['observed'];
  return keys.length === 1 && typeof observed === 'string' && observed.trim() !== '';
}

export function receiptL(observations: Partial<Record<ReceiptLField, unknown>>): {
  readonly complete: boolean;
  readonly missing: readonly ReceiptLField[];
} {
  const missing = RECEIPT_L_OBSERVATIONS.filter((field) => !filled(observations[field]));
  return { complete: missing.length === 0, missing };
}

export interface CaseResult {
  readonly result: 'pass' | 'fail' | 'unknown';
  readonly evidence: string;
}

export interface PreconditionEvidence {
  readonly state: 'held' | 'not_run' | 'not_a_condition';
  readonly evidence: string;
}

export interface ReceiptLPInput {
  readonly receiptL: Partial<Record<ReceiptLField, unknown>>;
  readonly cases: Readonly<Record<number, CaseResult>>;
  readonly preconditions: Readonly<Record<number, PreconditionEvidence>>;
  /** The measured interval of the revert, when case 8 ran. */
  readonly revertIntervalMs?: number;
}

function preconditionHolds(
  kind: PreconditionKind,
  entry: PreconditionEvidence | undefined,
): boolean {
  if (entry === undefined || entry.evidence.trim() === '') return false;
  if (kind === 'gate') return entry.state === 'held';
  if (kind === 'not_a_condition') return entry.state === 'not_a_condition';
  return entry.state === 'held' || entry.state === 'not_run';
}

export function receiptLP(input: ReceiptLPInput): {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly staysHeld: readonly string[];
} {
  const missing = [
    ...receiptL(input.receiptL).missing.map((field) => `receipt_l.${field}`),
    ...ACCEPTANCE_CASES.flatMap(({ id }) => {
      const entry = input.cases[id];
      return entry?.result === 'pass' && entry.evidence.trim() !== '' ? [] : [`case.${id}`];
    }),
    ...PRECONDITIONS.flatMap(({ id, kind }) =>
      preconditionHolds(kind, input.preconditions[id]) ? [] : [`precondition.${id}`],
    ),
  ];
  const interval = input.revertIntervalMs;
  const timed = typeof interval === 'number' && Number.isFinite(interval) && interval >= 0;
  if (input.cases[8]?.result === 'pass' && !timed) missing.push('revert_interval');
  return { complete: missing.length === 0, missing, staysHeld: STAYS_HELD };
}
