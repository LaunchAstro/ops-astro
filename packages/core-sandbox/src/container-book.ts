// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy's
// durable container record. Stub: every step accepts and nothing is due.

import type { SandboxResult } from './refusal.ts';

export type Recorded = {
  readonly id: string;
  readonly createdAt: number;
  readonly deadline: number;
  readonly wall: boolean;
  readonly killed: boolean;
  readonly waitAt: number | null;
  readonly attachAt: number | null;
  readonly closedAt: number | null;
};
export type ContainerBook = { readonly container: Recorded | null };
export type KillAnswer = 'landed' | 'not running' | 'failed';
export type DeleteAnswer = 'removed' | 'no such container' | 'failed';

export const GRACE_MS = 30_000;
export const EMPTY_CONTAINERS: ContainerBook = { container: null };

export const admitContainerCreate = (
  _book: ContainerBook,
  _daemonCount: number,
): SandboxResult<object> => ({ ok: true });
export const admitContainerOp = (_book: ContainerBook, _id: string): SandboxResult<object> => ({
  ok: true,
});
export const recordContainer = (
  book: ContainerBook,
  _id: string,
  _now: number,
  _wallMs: number,
  _wall: boolean,
): ContainerBook => book;
export const noteWaitReturned = (book: ContainerBook, _now: number): ContainerBook => book;
export const noteAttachEnded = (book: ContainerBook, _now: number): ContainerBook => book;
export const noteAttachClosed = (book: ContainerBook, _now: number): ContainerBook => book;
export const killAnswered = (book: ContainerBook, _answer: KillAnswer): ContainerBook => book;
export const containerDue = (
  _book: ContainerBook,
  _now: number,
): { kill: boolean; delete: boolean } => ({ kill: false, delete: false });
export const deleteAnswered = (
  book: ContainerBook,
  _answer: DeleteAnswer,
): { book: ContainerBook; sweep: boolean } => ({ book, sweep: false });
export const writeContainerBook = (_book: ContainerBook): Uint8Array => new Uint8Array();
export const readContainerBook = (_bytes: Uint8Array): SandboxResult<{ book: ContainerBook }> => ({
  ok: true,
  book: EMPTY_CONTAINERS,
});
