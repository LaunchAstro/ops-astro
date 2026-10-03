// SPDX-License-Identifier: AGPL-3.0-only
//
// The installation's sending subdomain (AW-07b sender, CS-16.15, research
// T5). At install one subdomain is set up with the email provider, which
// generates three records for it: DKIM, SPF and the return-path MX. Mail is
// refused until all three verify (`sendInboxEmail` reads the report), and the
// setup check reports the root domain's DMARC policy beside them.
//
// The answer is read the way the provider gives it, Resend's domain shape:
// `{ name, records: [{ record, type, status }] }`, where SPF's TXT and the
// return path's MX are both `record: "SPF"` and told apart by type. Anything
// else, a missing record or an unknown status, is not verified.
//
// Where it comes from sits behind `SenderSource`. With no provider account
// yet (owner line 68: not now), the only source is the fake
// (`email-sender-fake.ts`), and a report drawn from it says `mock: true`.

export type RecordStatus = 'verified' | 'pending' | 'failed' | 'missing';
export type DmarcPolicy = 'reject' | 'quarantine' | 'none' | 'missing' | 'invalid';

/** Where the setup check reads from: the provider's domain answer and the root's `_dmarc` TXT. */
export interface SenderSource {
  readonly mock: boolean;
  domain(): Promise<unknown>;
  dmarc(root: string): Promise<readonly string[]>;
}

/** The setup check's answer. `verified` is the one thing the send path reads. */
export interface SenderReport {
  readonly subdomain: string;
  readonly verified: boolean;
  readonly records: {
    readonly dkim: RecordStatus;
    readonly spf: RecordStatus;
    readonly returnPathMx: RecordStatus;
  };
  readonly dmarc: DmarcPolicy;
  readonly mock: boolean;
}

const STATUSES: ReadonlySet<string> = new Set(['verified', 'pending', 'failed']);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** One generated record's status, or `missing` when the answer lacks it or names an unknown status. */
function statusOf(
  records: readonly unknown[],
  record: string,
  types: readonly string[],
): RecordStatus {
  const found = records.filter((entry): entry is Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return false;
    const row = entry as Record<string, unknown>;
    return row['record'] === record && types.includes(String(row['type']));
  });
  if (found.length !== 1) return 'missing';
  const status = found[0]?.['status'];
  return typeof status === 'string' && STATUSES.has(status) ? (status as RecordStatus) : 'missing';
}

/** The root's DMARC policy from its `_dmarc` TXT records: exactly one `v=DMARC1` with a `p=` tag. */
export function dmarcPolicy(records: readonly string[]): DmarcPolicy {
  const dmarc = records.filter((text) => /^v=DMARC1\s*(?:;|$)/u.test(text.trim()));
  if (dmarc.length === 0) return 'missing';
  if (dmarc.length > 1) return 'invalid';
  const tags = (dmarc[0] ?? '').split(';').map((tag) => tag.trim().split('='));
  const policy = tags
    .find(([name]) => name?.trim() === 'p')?.[1]
    ?.trim()
    .toLowerCase();
  return policy === 'reject' || policy === 'quarantine' || policy === 'none' ? policy : 'invalid';
}

/**
 * The setup check: the subdomain's three records as the source answers, and
 * the root's DMARC policy. Verified only when the answer is for this exact
 * subdomain of this root and all three records verify. A source that throws
 * or answers another shape is not verified; nothing it said is returned.
 */
export async function checkSender(
  source: SenderSource,
  subdomain: string,
  root: string,
): Promise<SenderReport> {
  const unverified: SenderReport = {
    subdomain,
    verified: false,
    records: { dkim: 'missing', spf: 'missing', returnPathMx: 'missing' },
    dmarc: 'missing',
    mock: source.mock,
  };
  if (!HOST.test(subdomain) || !HOST.test(root) || !subdomain.endsWith(`.${root}`)) {
    return unverified;
  }
  let answer: unknown;
  let txt: readonly string[];
  try {
    [answer, txt] = await Promise.all([source.domain(), source.dmarc(root)]);
  } catch {
    return unverified;
  }
  const dmarc =
    Array.isArray(txt) && txt.every((t) => typeof t === 'string') ? dmarcPolicy(txt) : 'invalid';
  if (typeof answer !== 'object' || answer === null) return { ...unverified, dmarc };
  const { name, records } = answer as Record<string, unknown>;
  if (name !== subdomain || !Array.isArray(records)) return { ...unverified, dmarc };
  const found = {
    dkim: statusOf(records, 'DKIM', ['TXT', 'CNAME']),
    spf: statusOf(records, 'SPF', ['TXT']),
    returnPathMx: statusOf(records, 'SPF', ['MX']),
  };
  const verified = Object.values(found).every((status) => status === 'verified');
  return { subdomain, verified, records: found, dmarc, mock: source.mock };
}
