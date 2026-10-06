// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and B8 (docs/plan/sandbox-contract.md, sections 4 and 6): the proxy's
// durable candidate record. Stub: every step accepts.

import type { CreateShape } from './create-body.ts';
import type { SiteEntry } from './pin-list.ts';
import type { SandboxResult } from './refusal.ts';

export type CandidateRun = { readonly statusCode: number | null; readonly inTime: boolean };
export type Candidate = {
  readonly site: string;
  readonly entry: SiteEntry;
  readonly id: string;
  readonly createsLeft: number;
  readonly runs: readonly CandidateRun[];
};
export type AcceptedPin = {
  readonly site: string;
  readonly id: string;
  readonly lockfile: string;
  readonly attempt: number;
};
export type CandidateBook = {
  readonly candidates: readonly Candidate[];
  readonly accepted: readonly AcceptedPin[];
};
type Sites = ReadonlyMap<string, SiteEntry>;

export const EMPTY_BOOK: CandidateBook = { candidates: [], accepted: [] };

export const admitCandidateLoad = (
  book: CandidateBook,
  _sites: Sites,
  _site: string,
  _id: string,
): SandboxResult<{ book: CandidateBook }> => ({ ok: true, book });
export const candidateCreate = (
  _book: CandidateBook,
  _sites: Sites,
  _shape: CreateShape,
  _image: string,
): SandboxResult<{ site: string }> => ({ ok: true, site: '' });
export const countCandidateCreate = (book: CandidateBook, _id: string): CandidateBook => book;
export const recordCandidateWait = (
  book: CandidateBook,
  _id: string,
  _run: number,
  _statusCode: number,
  _inTime: boolean,
): CandidateBook => book;
export const readDeployed = (
  book: CandidateBook,
  sites: Sites,
): { book: CandidateBook; sites: Sites } => ({ book, sites });
export const holdsCandidateImage = (_book: CandidateBook, _id: string): boolean => true;
export const dropCandidateImage = (book: CandidateBook, _id: string): CandidateBook => book;
export const writeBook = (_book: CandidateBook): Uint8Array => new Uint8Array();
export const readBook = (_bytes: Uint8Array): SandboxResult<{ book: CandidateBook }> => ({
  ok: true,
  book: EMPTY_BOOK,
});
