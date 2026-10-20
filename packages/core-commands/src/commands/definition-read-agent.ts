// SPDX-License-Identifier: AGPL-3.0-only
//
// `definition.read` on the agent prefix (#1904): the lease holder's read of a
// file its run pinned, whose text it then carries in a turn's definition part.
//
// The read takes the model call's own lock path (`lockFacts`): the task, the
// run, the lease at its fence and held by this caller under this delegation,
// the delegation, the reservation and the step. Then the pinned read
// (`readPinned`), which writes the ledger row the broker later binds the part
// by, the audit copy and the read's one audit event. The bytes must decode as
// UTF-8, a BOM kept, and encode back to themselves.
//
// The lease is checked again on the database clock after `lockFacts`' last
// lock wait, and once more as the last statement, after the source read and
// `workJudged`'s standing, which waits on the delegation, the login and the
// business's audit chain (`final`, D1904-1). An expiry in any of those waits
// refuses the read and rolls back its ledger row, copy and event.
//
// The register keeps the read without its text (`stored`), and the read's event
// is its only one (`ownEvent`). A replay runs as a fresh call under
// `workJudged`, on the stored lease, fence, step and run, reads the file again
// against the stored identity and writes nothing.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import { lockFacts, type BrokerRefusal, type Facts } from '../../../core-custody/src/index.ts';
import type { Delegation, TenantQuery, TransactionQuery } from '../../../core-records/src/index.ts';
import {
  configuredInstructionSource,
  identityOf,
  readPinned,
  type InstructionSource,
} from '../../../core-runtime/src/index.ts';
import type { AgentCall, AgentRequest } from './agent-call.ts';
import { writeAuditEvent } from './audit.ts';
import { refused, type Applied, type HandlerOutcome, type Refused } from './outcome.ts';
import { comparablePayload } from './payload.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/** The four operands, and on a replay the read it repeats. */
export interface DefinitionReadOperands {
  readonly leaseId: string;
  readonly fence: number;
  readonly stepId: string;
  readonly path: string;
  readonly again?: KeptRead;
}

/** A read as the register keeps it: everything but the text. */
export interface KeptRead {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly sequence: number;
  readonly leaseId: string;
  readonly fence: number;
  readonly stepId: string;
  readonly runId: string;
}

const OPERANDS = ['leaseId', 'fence', 'stepId', 'path'];
const ENVELOPE = new Set(['command', 'operationId']);

const BODY_FIXES: readonly string[] = [
  'Send exactly leaseId, fence, stepId and path: the lease and fence your pickup gave, its step, and the file.',
];
const READ_FIXES: readonly string[] = [
  'Read with the live lease your own pickup was issued for this run, at its fence.',
];
const NO_ROOT_FIXES: readonly string[] = [
  'This deployment has no instruction root configured, so no pinned file can be read.',
];

/** Exactly the four operands, before any authority; a stray key, `runId` included, names itself. */
export function definitionReadOperands(request: AgentRequest): DefinitionReadOperands | Refused {
  const body = request as Readonly<Record<string, unknown>>;
  const stray = Object.keys(body).filter((key) => !ENVELOPE.has(key) && !OPERANDS.includes(key));
  const { leaseId, fence, stepId, path } = body;
  if (
    stray.length > 0 ||
    typeof leaseId !== 'string' ||
    typeof fence !== 'number' ||
    typeof stepId !== 'string' ||
    typeof path !== 'string'
  ) {
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', stray.length > 0 ? stray : OPERANDS, BODY_FIXES),
    );
  }
  return { leaseId, fence, stepId, path };
}

const brokerRefusal = (code: BrokerRefusal): Refused =>
  refused(refuseCommand(code, ['definition.read'], READ_FIXES));

/** The agent entry's transaction is a `withBusiness` one, which the pinned read's savepoint needs. */
function transactionOf(tx: TenantQuery): TransactionQuery {
  if (!('savepoint' in tx)) throw new Error('definition.read: served outside a transaction');
  return tx as TransactionQuery;
}

/** UTF-8, a BOM kept, that encodes back to the same bytes; else undefined. */
function decoded(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return Buffer.from(text, 'utf8').equals(Buffer.from(bytes)) ? text : undefined;
}

const notUtf8 = (): Refused =>
  refused(
    refuseCommand(
      'DEFINITION_DIGEST_MISMATCH',
      [],
      ['The pinned file is not UTF-8 text, so it cannot be a definition.'],
    ),
  );

/** The serve: a first read, or a replay's read again (`again`). */
export async function serveDefinitionRead(
  tx: TenantQuery,
  call: AgentCall,
  operands: DefinitionReadOperands,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  const { again } = operands;
  const caller = { actorId: call.session.actorId, delegationId: delegation.id };
  const checked = await lockFacts(tx, { ...caller, attendedByPersonId: null }, again ?? operands);
  if (!checked.ok) return brokerRefusal(checked.code);
  const { facts } = checked;
  if (again !== undefined && facts.runId !== again.runId) return brokerRefusal('LEASE_NOT_OWNED');
  // `lockFacts` judged the lease before its reservation wait: one that ended in
  // that wait is `LEASE_EXPIRED` here, before the pinned read's own check.
  const ended = await leaseLive(tx, { ...facts, fence: (again ?? operands).fence });
  if (ended !== undefined) return refused(ended);
  const source = configuredInstructionSource();
  if (source === undefined) {
    return refused(refuseCommand('DEFINITION_UNAVAILABLE', [], NO_ROOT_FIXES));
  }
  const read =
    again === undefined
      ? await firstRead(tx, call, facts, source, operands)
      : await readAgain(source, again);
  if ('refusal' in read) return read;
  const text = decoded(read.bytes);
  if (text === undefined) return notUtf8();
  return { recordId: facts.source.id, revision: null, detail: { ...read.kept, text } };
}

interface Read {
  readonly kept: KeptRead;
  readonly bytes: Uint8Array;
}

/** The pinned read, under the locks `lockFacts` took, with the read's one audit event. */
async function firstRead(
  tx: TenantQuery,
  call: AgentCall,
  facts: Facts,
  source: InstructionSource,
  operands: DefinitionReadOperands,
): Promise<Read | Refused> {
  const { leaseId, holderActorId, runId, stepId } = facts;
  const request = { leaseId, holderActorId, runId, stepId, path: operands.path };
  const read = await readPinned(transactionOf(tx), request, source, async (inner) => {
    // The read's one audit event (`ownEvent`): the envelope writes none.
    await writeAuditEvent(inner, {
      actorId: call.session.actorId,
      command: call.request.command,
      operationId: String(call.request['operationId']),
      outcome: 'applied',
      subjectRecordId: facts.source.id,
      payloadDigest: payloadDigest(comparablePayload(call.request)),
    });
  });
  if (!read.ok) return refused(read.refusal);
  const { path, digest, size } = read.value.identity;
  const { sequence } = read.value;
  const kept = { path, digest, size, sequence, leaseId, fence: operands.fence, stepId, runId };
  return { kept, bytes: read.value.bytes };
}

/** A replay's read: the file again, at the identity the stored read had. */
async function readAgain(source: InstructionSource, again: KeptRead): Promise<Read | Refused> {
  const bytes = await source.read(again.path);
  const identity = bytes === undefined ? undefined : identityOf(again.path, bytes);
  if (bytes === undefined || identity?.digest !== again.digest || identity.size !== again.size) {
    return refused(
      refuseCommand('DEFINITION_DIGEST_MISMATCH', [], ['The file is not the one this read read.']),
    );
  }
  return { kept: again, bytes };
}

/** The register's row: the read without its text. */
export function storedRead(detail: Applied['detail']): Applied['detail'] {
  const { text: _text, ...kept } = detail;
  return kept;
}

/** The stored read, when the register row is one; else undefined. */
export function keptRead(detail: Applied['detail']): KeptRead | undefined {
  const { path, digest, size, sequence, leaseId, fence, stepId, runId } = detail;
  const strings = [path, digest, leaseId, stepId, runId];
  if (!strings.every((value) => typeof value === 'string')) return undefined;
  if (typeof size !== 'number' || typeof sequence !== 'number' || typeof fence !== 'number') {
    return undefined;
  }
  return detail as unknown as KeptRead;
}

const EXPIRED_FIXES: readonly string[] = [
  'The lease ended while the read waited, so nothing was read. Pick the work up again.',
];

/**
 * The final lease check (D1904-1): the last statement before the outcome, on
 * the lease row this transaction holds, after `workJudged`'s standing and its
 * waits, judged on the database clock.
 */
export async function leaseStillLive(
  tx: TenantQuery,
  ran: Applied,
): Promise<CommandRefusal | undefined> {
  const read = keptRead(ran.detail);
  if (read === undefined) throw new Error('definition.read: an applied read without its lease');
  return await leaseLive(tx, read);
}

/** The lease live at its fence on its run, now, on the database clock. */
async function leaseLive(
  tx: TenantQuery,
  at: Pick<KeptRead, 'leaseId' | 'runId' | 'fence'>,
): Promise<CommandRefusal | undefined> {
  const live = await tx.query(
    `select 1 from public.leases
      where business_id = $1 and id = $2 and run_id = $3 and fence = $4
        and state = 'live' and expires_at > clock_timestamp()`,
    [tx.businessId, at.leaseId, at.runId, at.fence],
  );
  return live.length > 0 ? undefined : refuseCommand('LEASE_EXPIRED', [], EXPIRED_FIXES);
}

/** What a row keeps of an applied call, where it differs from the default (#1904). */
export interface RowKeeping {
  /** The detail as the register keeps it, after the credential is removed (`recordApplied`). */
  readonly stored?: (detail: Applied['detail']) => Applied['detail'];
  /** The handler wrote the call's one audit event itself, so `recordApplied` writes none. */
  readonly ownEvent?: true;
  /** A last check on an applied outcome, once `workJudged`'s standing has passed its waits. */
  readonly final?: (tx: TenantQuery, ran: Applied) => Promise<CommandRefusal | undefined>;
}

/** The row `agent-operations.ts` serves `definition.read` by. */
export const DEFINITION_READ: {
  readonly authority: 'record';
  readonly subjectTask: 'lease';
  readonly replay: 'definitionRead';
  readonly operands: (request: AgentRequest) => DefinitionReadOperands | Refused;
  readonly stored: (detail: Applied['detail']) => Applied['detail'];
  readonly ownEvent: true;
  readonly final: (tx: TenantQuery, ran: Applied) => Promise<CommandRefusal | undefined>;
  readonly serve: typeof serveDefinitionRead;
} = {
  authority: 'record',
  subjectTask: 'lease',
  replay: 'definitionRead',
  operands: definitionReadOperands,
  stored: storedRead,
  ownEvent: true,
  final: leaseStillLive,
  serve: serveDefinitionRead,
};
