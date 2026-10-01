// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, ask and mail: a signed-out person asks for a reset by address, and the
// login provider's Send Email hook asks for the reset mail.
//
// **The ask** (`requestPasswordReset`) hands the address to the login
// provider through custody (`auth.recover`); the provider mints its own
// single-use, short-lived token and asks the hook to mail it. The route
// answers before any of this, the same for every address, so neither the
// answer nor its time says whether an account exists. Asking mints a token
// that voids the last mailed link, and spends the provider's mail and custody
// budget, so the limits are counted first and a refused ask never reaches the
// provider: the asks from the ask's source (`RESET_SOURCE_LIMIT`, 0226) and
// for its address (`RESET_LIMIT`, 0227), refused asks included, and the
// address's reset mail (`RESET_LIMIT`, 0225), in the last hour. Each ask's
// own transaction sweeps up to `RESET_SWEEP` asks older than the hour.
//
// **The mail** (`sendPasswordReset`), system work under the hook's verified
// signature. The message's login is looked for in each of the deployment's
// businesses, every one of them. A login no business maps gets no mail. Else,
// in the first business it is mapped in, one transaction: a replayed message
// id is refused; the login's mail and the address's mail in the last hour are
// counted (SP-14: at most `RESET_LIMIT` each); the attempt is recorded
// `asked` (0225); and `account.password_reset_requested` is audited, as it is
// in every other business the login reaches. Then one mail through the
// broker's `email.send`, its link the provider's hashed token in the
// fragment, and what came back recorded as the attempt's next row. No row,
// audit payload, answer or log holds the address, the token or the link.

import { createHash, randomUUID } from 'node:crypto';
import type { Recovery } from '../../../core-connectors/src/index.ts';
import {
  askRecovery,
  sendResetMail,
  type Broker,
  type MailSettings,
} from '../../../core-custody/src/index.ts';
import {
  standingOf,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';

export const PASSWORD_RESET_REQUESTED = 'account.password_reset_requested';

/** Reset mails per login, and per address, in `RESET_WINDOW_SECONDS` (SP-14). */
export const RESET_LIMIT = 3;
export const RESET_WINDOW_SECONDS: number = 60 * 60;
/** Reset asks per client address in `RESET_WINDOW_SECONDS`, refused ones included. */
export const RESET_SOURCE_LIMIT = 10;
/** Asks older than the window one ask deletes, at most (0227's policy admits no newer one). */
const RESET_SWEEP = 100;

/** An address as the provider keeps one: no space, one `@`, bounded. */
const ADDRESS = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** One ask: the address as sent, and the client address it came from. */
export interface ResetAsk {
  readonly address: unknown;
  readonly source: string;
}

/** The ask names no business: its rows (0225, 0226) are the installation's. */
const NO_BUSINESS: BusinessId = '00000000-0000-0000-0000-000000000000';

/** Whether an ask is within its limits; its own row is written, and committed, first. */
async function withinLimits(database: Database, source: string, address: string): Promise<boolean> {
  // Committed before the count, so of asks racing from one source, or for one
  // address, at most the limit see a count within it: the last one to commit
  // counts every other. The same transaction sweeps a bounded few old asks.
  await database.withBusiness(NO_BUSINESS, async (tx) => {
    await tx.query(
      'insert into ops.password_reset_asks (source_digest, address_digest) values ($1, $2)',
      [source, address],
    );
    await tx.query(
      `delete from ops.password_reset_asks
        where recorded_at < now() - make_interval(secs => $1)
          and recorded_at <= coalesce((select recorded_at from ops.password_reset_asks
                where recorded_at < now() - make_interval(secs => $1)
                order by recorded_at offset $2 limit 1), 'infinity')`,
      [RESET_WINDOW_SECONDS, RESET_SWEEP - 1],
    );
  });
  const [counted] = await database.withBusiness(
    NO_BUSINESS,
    async (tx) =>
      await tx.query<{ source: number; asks: number; mails: number }>(
        `select (select count(*) from ops.password_reset_asks where source_digest = $1
                   and recorded_at > now() - make_interval(secs => $3))::int as source,
                (select count(*) from ops.password_reset_asks where address_digest = $2
                   and recorded_at > now() - make_interval(secs => $3))::int as asks,
                (select count(*) from ops.password_reset_attempts where state = 'asked'
                   and address_digest = $2
                   and recorded_at > now() - make_interval(secs => $3))::int as mails`,
        [source, address, RESET_WINDOW_SECONDS],
      ),
  );
  return (
    (counted?.source ?? 0) <= RESET_SOURCE_LIMIT &&
    (counted?.asks ?? 0) <= RESET_LIMIT &&
    (counted?.mails ?? 0) < RESET_LIMIT
  );
}

/**
 * Hand one address to the login provider; nothing is said back, whatever
 * happened. `counted` runs once the database work is over, before the provider
 * is asked, whatever the outcome.
 */
export async function requestPasswordReset(
  database: Database,
  broker: Broker,
  asking: ResetAsk,
  counted: () => void = () => {},
): Promise<void> {
  let asked: string;
  try {
    if (typeof asking.address !== 'string') return;
    asked = asking.address.trim().toLowerCase();
    if (!ADDRESS.test(asked)) return;
    if (!(await withinLimits(database, digest(asking.source), digest(asked)))) return;
  } finally {
    counted();
  }
  await askRecovery(broker, asked);
}

/** The verified hook message a reset mail answers. */
export interface ResetMessage {
  readonly id: string;
  readonly address: string;
  readonly recovery: Recovery;
}

export type ResetMailOutcome = 'SENT' | 'NOT_SENT' | 'REPLAYED';

interface Mapped {
  readonly business: BusinessId;
  readonly personId: string;
  readonly actorId: string;
}

/** Each business the login is mapped in, with its person and actor; read only. */
async function mappedIn(
  database: Database,
  businesses: readonly BusinessId[],
  subject: string,
): Promise<Mapped[]> {
  const found: Mapped[] = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const standing = await database.withBusiness(
      business,
      async (tx) => await standingOf(tx, { provider: 'supabase', subject }, 'enrolling'),
    );
    if (!('refused' in standing)) {
      found.push({ business, personId: standing.personId, actorId: standing.actorId });
    }
  }
  return found;
}

async function audit(tx: TenantQuery, mapped: Mapped): Promise<void> {
  await writeAuditEvent(tx, {
    actorId: mapped.actorId,
    command: PASSWORD_RESET_REQUESTED,
    outcome: 'applied',
    refusalCode: null,
    payloadDigest: payloadDigest({ command: PASSWORD_RESET_REQUESTED, person: mapped.personId }),
  });
}

interface Attempt {
  readonly subject: string;
  readonly address: string;
  readonly attempt: string;
}

async function record(
  tx: TenantQuery,
  attempt: Attempt,
  state: string,
  evidence: string,
): Promise<boolean> {
  const rows = await tx.query(
    `insert into ops.password_reset_attempts
       (subject_digest, address_digest, attempt, state, evidence)
     values ($1, $2, $3, $4, $5)
     on conflict (evidence) where state = 'asked' do nothing
     returning 1`,
    [attempt.subject, attempt.address, attempt.attempt, state, evidence],
  );
  return rows.length === 1;
}

/** In the first business: replay, the limits, the `asked` row and the audit; or why not. */
async function ask(
  tx: TenantQuery,
  first: Mapped,
  attempt: Attempt,
  hookId: string,
): Promise<'ASKED' | 'REPLAYED' | 'LIMITED'> {
  const [seen] = await tx.query<{ replayed: boolean; login: number; address: number }>(
    `select exists (select 1 from ops.password_reset_attempts
                     where state = 'asked' and evidence = $1) as replayed,
            (select count(*) from ops.password_reset_attempts where state = 'asked'
               and subject_digest = $2
               and recorded_at > now() - make_interval(secs => $4))::int as login,
            (select count(*) from ops.password_reset_attempts where state = 'asked'
               and address_digest = $3
               and recorded_at > now() - make_interval(secs => $4))::int as address`,
    [`hook:${hookId}`, attempt.subject, attempt.address, RESET_WINDOW_SECONDS],
  );
  if (seen?.replayed === true) return 'REPLAYED';
  if ((seen?.login ?? 0) >= RESET_LIMIT || (seen?.address ?? 0) >= RESET_LIMIT) return 'LIMITED';
  if (!(await record(tx, attempt, 'asked', `hook:${hookId}`))) return 'REPLAYED';
  await audit(tx, first);
  return 'ASKED';
}

/** Mail one reset link for a verified hook message, or send nothing. */
export async function sendPasswordReset(
  database: Database,
  businesses: readonly BusinessId[],
  sending: { readonly broker: Broker; readonly mail: MailSettings },
  message: ResetMessage,
): Promise<ResetMailOutcome> {
  const mapped = await mappedIn(database, businesses, message.recovery.subject);
  const [first, ...others] = mapped;
  if (first === undefined) return 'NOT_SENT';
  const attempt = {
    subject: digest(message.recovery.subject),
    address: digest(message.address),
    attempt: randomUUID(),
  };
  const asked = await database.withBusiness(
    first.business,
    async (tx) => await ask(tx, first, attempt, message.id),
  );
  if (asked !== 'ASKED') return asked === 'REPLAYED' ? 'REPLAYED' : 'NOT_SENT';
  for (const next of others) {
    // oxlint-disable-next-line no-await-in-loop -- one business's transaction at a time
    await database.withBusiness(next.business, async (tx) => await audit(tx, next));
  }
  const sent = await sendResetMail(
    sending.broker,
    sending.mail,
    message.address,
    message.recovery.tokenHash,
  );
  const state = sent.state === 'accepted' ? 'accepted' : 'failed';
  await database.withBusiness(first.business, async (tx) => {
    await record(tx, attempt, state, sent.evidence.slice(0, 200));
  });
  return sent.state === 'accepted' ? 'SENT' : 'NOT_SENT';
}
