// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: what the trace target answered, for the export's bodies and
// retention's deletes alike. Delivery is custody's egress (`Deliver`);
// anything short of a 2xx JSON reply is a gap with a fixed code.

/** What delivery answers: custody's `Outbound`, narrowed to what the exporter reads. */
export type Delivered =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: string; readonly status: number | null };

export type Deliver = (body: string) => Promise<Delivered>;

export type GapCode =
  | 'target_unreachable'
  | 'target_redirect'
  | 'target_timeout'
  | 'target_oversized_reply'
  | 'target_oversized_body'
  | 'target_malformed_reply'
  | 'target_refused'
  | 'target_forbidden';

const FAULT_GAP: Readonly<Record<string, GapCode>> = {
  redirect: 'target_redirect',
  timeout: 'target_timeout',
  too_large: 'target_oversized_reply',
  forbidden: 'target_forbidden',
  unlisted: 'target_forbidden',
  bad_path: 'target_forbidden',
  status: 'target_refused',
  network: 'target_unreachable',
};

/** Null for a landed delivery; otherwise the gap's fixed code. Retention reads its deletes the same way. */
export function gapOf(answer: Delivered): GapCode | null {
  if (answer.status === 413) return 'target_oversized_body';
  if (!answer.ok) return FAULT_GAP[answer.fault] ?? 'target_unreachable';
  if (answer.status < 200 || answer.status > 299) return 'target_refused';
  try {
    const parsed: unknown = JSON.parse(answer.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'target_malformed_reply';
  } catch {
    return 'target_malformed_reply';
  }
}
