// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy's one
// decision point over its two durable records. Stub: it forwards
// everything and records nothing.

import { type CandidateBook, EMPTY_BOOK } from './candidate-book.ts';
import { type ContainerBook, EMPTY_CONTAINERS } from './container-book.ts';
import type { ProxyOp } from './proxy-request.ts';
import type { SandboxResult } from './refusal.ts';
import type { SweepDaemon } from './sweep.ts';

type Reply = { readonly status: number; readonly body: Uint8Array };
/** The operations this flow decides: everything but P5's loads and image calls (piece 2d-ii). */
export type StateOp = Exclude<ProxyOp, { kind: 'load' | 'image-inspect' | 'image-delete' }>;
export type ProxyPorts = {
  /** The one file holding both records; `read` gives null before the first write. */
  readonly store: {
    readonly read: () => Promise<Uint8Array | null>;
    readonly write: (bytes: Uint8Array) => Promise<void>;
  };
  /** The deployed pin list as the deploy wrote it. */
  readonly pins: () => Promise<Uint8Array>;
  /** The sweep's three calls, and every other operation rebuilt from its checked form. */
  readonly daemon: SweepDaemon & { readonly forward: (op: StateOp) => Promise<Reply> };
  /** Wall time in ms. */
  readonly now: () => number;
};
export type ProxyRecord = {
  readonly candidates: CandidateBook;
  readonly containers: ContainerBook;
};

export const writeProxyRecord = (_record: ProxyRecord): Uint8Array => new Uint8Array();

export const readProxyRecord = (_bytes: Uint8Array): SandboxResult<{ record: ProxyRecord }> => ({
  ok: true,
  record: { candidates: EMPTY_BOOK, containers: EMPTY_CONTAINERS },
});

export class ProxyState {
  readonly #ports: ProxyPorts;

  private constructor(ports: ProxyPorts) {
    this.#ports = ports;
  }

  static open(ports: ProxyPorts): Promise<SandboxResult<{ state: ProxyState }>> {
    return Promise.resolve({ ok: true, state: new ProxyState(ports) });
  }

  async handle(op: StateOp): Promise<SandboxResult<{ reply: Reply }>> {
    return { ok: true, reply: await this.#ports.daemon.forward(op) };
  }

  tick(): Promise<void> {
    return Promise.resolve();
  }

  attachEnded(_id: string): Promise<void> {
    return Promise.resolve();
  }

  attachClosed(_id: string): Promise<void> {
    return Promise.resolve();
  }
}
