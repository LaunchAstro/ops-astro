// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's handle on custody: start its process, send it one dispatch at
// a time per request id, and read back what happened (AW-01).
//
// The broker's process never sees a credential. It passes custody the path of
// the credential file and the destination list in custody's own environment
// and passes nothing of its own environment on, so a key in the parent's
// environment could not reach custody either and custody's could not come back.
//
// What a dispatch can answer, in the order the broker records them:
// `accepted` (custody took it), `started` (custody is sending it), then an
// answer or a fault. If custody's process ends before the answer, the
// dispatch answers `worker_lost` with the fault ours: the provider may or may
// not have acted, so the broker holds the reservation and never redispatches
// without positive proof. A site answer custody judged after sending it
// answers `withheld` (`echoed` or `malformed`): sent, so never a refusal.
//
// A paid send is admitted again at the handoff (#1508, #1509's hook): the
// broker's `admit` judges it in a transaction it holds open until custody says
// `started` (or answers first), so a revocation that commits after the
// judgement waits until custody has the request. Refused, custody is never
// asked, and the dispatch answers `CUSTODY_NOT_ADMITTED`: nothing was sent.

import { fork, type ChildProcess } from 'node:child_process';
import { exchangeWith, type Exchange, type Notes } from './custody-exchange.ts';
import { join } from 'node:path';
import type { StorableKind } from './credentials.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Handoff } from './carriage.ts';
import type { Destination, Outbound, OutboundRequest, SendGate } from './egress.ts';

export type { SendGate } from './egress.ts';

export type CustodyOutcome =
  | {
      readonly kind: 'answered';
      readonly started: boolean;
      readonly outbound: Outbound;
      readonly credentialKind: StorableKind;
      readonly account: string | null;
    }
  | { readonly kind: 'refused'; readonly started: false; readonly code: string }
  | { readonly kind: 'worker_lost'; readonly started: boolean; readonly fault: 'ours' }
  | { readonly kind: 'withheld'; readonly started: true; readonly reason: 'echoed' | 'malformed' };

export interface Carrier {
  readonly credentialKind: StorableKind;
  readonly account: string | null;
  /** Whether custody sends the credential: false only for one filed as `none`. */
  readonly presents: boolean;
  /** How it is sent: as a bearer token, a Basic pair, or not at all. */
  readonly scheme: 'bearer' | 'basic' | 'none';
}

export interface CustodyConfig {
  readonly credentialsFile: string;
  readonly destinations: readonly Destination[];
  /** The owner's ChatGPT plan: its token file and its issuer (#1620 P4). */
  readonly plan?: { readonly tokenFile: string; readonly issuer: string };
}

export type Prepared = { readonly ok: true } | { readonly ok: false; readonly code: string };

/**
 * A send admitted at the handoff, its transaction still open. At custody's
 * `started`, `go` asks that transaction one statement more: answered, its
 * locks were held to that instant and custody sends; a transaction lost since
 * the verdict answers false and nothing is sent. `end` lets it go either way.
 */
export interface Admission {
  readonly go: () => Promise<boolean>;
  readonly end: () => void;
}

/** The judgement at the handoff: the admission, or undefined when nothing may be sent. */
export type Admit = () => Promise<Admission | undefined>;

export interface Custody {
  readonly pid: number;
  dispatch(
    credentialRef: string,
    request: OutboundRequest,
    onPiece?: (text: string) => void,
    admit?: Admit,
    /** A carried call's handoff from the command layer (`carried-custody.ts`); process custody takes none. */
    handoff?: Handoff,
  ): Promise<CustodyOutcome>;
  /**
   * A carried custody's settlement fence, in the settling transaction: whether
   * the call may still settle on the answer heard. Process custody has none.
   */
  fenceIn?(tx: TenantQuery, callId: string): Promise<boolean>;
  /**
   * The kind and account of the credential custody would present to
   * `destination` under `credentialRef`, or null when it holds none there:
   * what the broker records on a call before sending it (AW-10, catalogue #439).
   */
  describe(credentialRef: string, destination: string): Promise<Carrier | null>;
  /** Everything custody wrote to stderr, for the canary proofs. */
  stderr(): string;
  /** Send a raw message, for the no-borrow proof: answers what custody replied. */
  raw(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
  stop(): Promise<void>;
}

/**
 * Custody's own process, which can also send a request that must be written
 * by a deadline on this machine's clock: it says when it was written, and
 * past the deadline it writes nothing and is refused `SEND_LAPSED`.
 */
export interface ProcessCustody extends Custody {
  dispatchBefore(
    credentialRef: string,
    request: OutboundRequest,
    gate: Required<Pick<SendGate, 'deadlineAt' | 'onWritten'>>,
    onPiece?: (text: string) => void,
  ): Promise<CustodyOutcome>;
  /** The plan's token made ready to present; never the token itself. */
  prepare(): Promise<Prepared>;
}

function forkCustody(config: CustodyConfig): ChildProcess {
  // A file path, not a URL: under a browser-like test environment the
  // module's URL is not a file one, and custody is still a local process.
  const entry = join(import.meta.dirname, 'custody-main.ts');
  return fork(entry, [], {
    env: {
      CUSTODY_CREDENTIALS_FILE: config.credentialsFile,
      CUSTODY_DESTINATIONS: JSON.stringify(config.destinations),
      ...(config.plan === undefined
        ? {}
        : {
            CUSTODY_PLAN_TOKEN_FILE: config.plan.tokenFile,
            CUSTODY_PLAN_ISSUER: config.plan.issuer,
          }),
    },
    // No inherited flag, and no inspector on SIGUSR1: custody holds the credentials.
    // The plan's token store is on node:sqlite, which warns as experimental: custody's stderr is its own words.
    execArgv: ['--disable-sigusr1', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
  });
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onReady = (message: unknown): void => {
      if ((message as Record<string, unknown>)['type'] === 'ready') {
        child.off('message', onReady);
        resolve();
      }
    };
    child.on('message', onReady);
    child.once('exit', (code) => reject(new Error(`custody did not start (${String(code)})`)));
  });
}

function outcomeOf(reply: Record<string, unknown> | 'lost', started: boolean): CustodyOutcome {
  if (reply === 'lost') return { kind: 'worker_lost', started, fault: 'ours' };
  if (reply['type'] === 'answer') {
    return {
      kind: 'answered',
      started: true,
      outbound: reply['outcome'] as Outbound,
      credentialKind: reply['kind'] as StorableKind,
      account: (reply['account'] as string | null) ?? null,
    };
  }
  if (reply['type'] === 'withheld') {
    const reason = reply['reason'] === 'echoed' ? 'echoed' : 'malformed';
    return { kind: 'withheld', started: true, reason };
  }
  return { kind: 'refused', started: false, code: String(reply['code']) };
}

/** One dispatch through custody, its started note kept and the others passed on. */
async function dispatchOn(
  exchange: Exchange,
  body: Record<string, unknown>,
  notes: Omit<Notes, 'started'>,
): Promise<CustodyOutcome> {
  let started = false;
  const reply = await exchange(body, { ...notes, started: () => (started = true) });
  return outcomeOf(reply, started);
}

/** Past its deadline custody wrote nothing: a refusal, not an answer. */
function lapsedRefused(outcome: CustodyOutcome): CustodyOutcome {
  const lapsed =
    outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault === 'lapsed';
  return lapsed ? { kind: 'refused', started: false, code: 'SEND_LAPSED' } : outcome;
}

/** A dispatch that asks to be admitted, gated on that admission at `started`. */
async function admittedDispatch(
  exchange: Exchange,
  body: Record<string, unknown>,
  onPiece: ((text: string) => void) | undefined,
  admit: Parameters<Custody['dispatch']>[3],
): Promise<CustodyOutcome> {
  const admission = admit === undefined ? undefined : await admit().catch(() => null);
  if (admit !== undefined && (admission === undefined || admission === null)) {
    return { kind: 'refused', started: false, code: 'CUSTODY_NOT_ADMITTED' };
  }
  const gated = admission === undefined ? {} : { gated: true };
  try {
    return await dispatchOn(
      exchange,
      { ...body, ...gated },
      { piece: onPiece, gate: admission?.go },
    );
  } finally {
    admission?.end();
  }
}

async function describeCarrier(
  exchange: Exchange,
  credentialRef: string,
  destination: string,
): Promise<Carrier | null> {
  const reply = await exchange({ type: 'describe', credentialRef, destination });
  if (reply === 'lost' || reply['type'] !== 'described') return null;
  return {
    credentialKind: reply['kind'] as StorableKind,
    account: (reply['account'] as string | null) ?? null,
    presents: reply['presents'] !== false,
    scheme: (reply['scheme'] as Carrier['scheme'] | undefined) ?? 'bearer',
  };
}

export async function startCustody(config: CustodyConfig): Promise<ProcessCustody> {
  const child = forkCustody(config);
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  const exchange = exchangeWith(child);
  await ready(child);
  const custody: ProcessCustody = {
    pid: child.pid ?? -1,
    dispatchBefore: async (credentialRef, request, gate, onPiece) => {
      const body = { type: 'dispatch', credentialRef, request, deadlineAt: gate.deadlineAt };
      return lapsedRefused(
        await dispatchOn(exchange, body, { written: gate.onWritten, piece: onPiece }),
      );
    },
    dispatch: async (credentialRef, request, onPiece, admit) =>
      await admittedDispatch(
        exchange,
        { type: 'dispatch', credentialRef, request },
        onPiece,
        admit,
      ),
    prepare: async () => {
      const reply = await exchange({ type: 'prepare' });
      if (reply === 'lost') return { ok: false, code: 'CUSTODY_LOST' };
      return reply['type'] === 'prepared'
        ? { ok: true }
        : { ok: false, code: String(reply['code']) };
    },
    describe: async (credentialRef, destination) =>
      await describeCarrier(exchange, credentialRef, destination),
    stderr: () => errors,
    raw: async (message) => {
      const reply = await exchange(message);
      return reply === 'lost' ? { type: 'lost' } : reply;
    },
    kill: () => {
      child.kill('SIGKILL');
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    },
  };
  return custody;
}
