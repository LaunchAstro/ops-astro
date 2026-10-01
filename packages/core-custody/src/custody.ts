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
// without positive proof.

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { StorableKind } from './credentials.ts';
import type { Destination, Outbound, OutboundRequest } from './egress.ts';

export type CustodyOutcome =
  | {
      readonly kind: 'answered';
      readonly started: boolean;
      readonly outbound: Outbound;
      readonly credentialKind: StorableKind;
      readonly account: string | null;
    }
  | { readonly kind: 'refused'; readonly started: false; readonly code: string }
  | { readonly kind: 'worker_lost'; readonly started: boolean; readonly fault: 'ours' };

export interface CustodyConfig {
  readonly credentialsFile: string;
  readonly destinations: readonly Destination[];
}

export interface Custody {
  readonly pid: number;
  dispatch(credentialRef: string, request: OutboundRequest): Promise<CustodyOutcome>;
  /** Everything custody wrote to stderr, for the canary proofs. */
  stderr(): string;
  /** Send a raw message, for the no-borrow proof: answers what custody replied. */
  raw(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
  stop(): Promise<void>;
}

function forkCustody(config: CustodyConfig): ChildProcess {
  // A file path, not a URL: under a browser-like test environment the
  // module's URL is not a file one, and custody is still a local process.
  const entry = join(import.meta.dirname, 'custody-main.ts');
  return fork(entry, [], {
    env: {
      CUSTODY_CREDENTIALS_FILE: config.credentialsFile,
      CUSTODY_DESTINATIONS: JSON.stringify(config.destinations),
    },
    execArgv: [],
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

type Exchange = (
  body: Record<string, unknown>,
  onStarted?: () => void,
) => Promise<Record<string, unknown> | 'lost'>;

/** One message out and its answer back, or `lost` when custody goes first. A `started` note is passed on, never taken as the answer. */
function exchangeWith(child: ChildProcess): Exchange {
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  const lost = new Set<() => void>();
  child.on('message', (message: unknown) => {
    const shape = message as Record<string, unknown>;
    const id = shape['id'];
    if (typeof id === 'string') waiting.get(id)?.(shape);
  });
  child.on('exit', () => {
    for (const notify of lost) notify();
  });
  return async (body, onStarted) =>
    await new Promise((resolve) => {
      const id = randomUUID();
      const onLost = (): void => {
        waiting.delete(id);
        lost.delete(onLost);
        resolve('lost');
      };
      lost.add(onLost);
      waiting.set(id, (message) => {
        if (message['type'] === 'started') {
          onStarted?.();
          return;
        }
        waiting.delete(id);
        lost.delete(onLost);
        resolve(message);
      });
      if (child.exitCode !== null || !child.connected) {
        onLost();
        return;
      }
      child.send({ ...body, id });
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
  return { kind: 'refused', started: false, code: String(reply['code']) };
}

export async function startCustody(config: CustodyConfig): Promise<Custody> {
  const child = forkCustody(config);
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  const exchange = exchangeWith(child);
  await ready(child);
  return {
    pid: child.pid ?? -1,
    dispatch: async (credentialRef, request) => {
      let started = false;
      const reply = await exchange({ type: 'dispatch', credentialRef, request }, () => {
        started = true;
      });
      return outcomeOf(reply, started);
    },
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
}
