// SPDX-License-Identifier: AGPL-3.0-only
//
// The sandbox's grammars' one way in (docs/plan/sandbox-contract.md, ADR
// 0048): requests, replies, a run's input and its output. It imports nothing of the
// product and runs no container.

export { AttachFrames, type AttachEnd } from './attach-frames.ts';
export {
  admitCandidateLoad,
  candidateCreate,
  type CandidateBook,
  countCandidateCreate,
  dropCandidateImage,
  EMPTY_BOOK,
  holdsCandidateImage,
  readBook,
  readDeployed,
  recordCandidateWait,
  writeBook,
} from './candidate-book.ts';
export { readBuildRequest, type BuildRequest, type SiteOf } from './build-request.ts';
export {
  fixedCreateBody,
  matchCreateBody,
  type CreateShape,
  type Crossing,
} from './create-body.ts';
export * from './daemon-reply.ts';
export { assembleTree, type GitRead } from './git-tree.ts';
export { checkTree, type TreeEntry } from './input-tree.ts';
export { writeLayer } from './layer-writer.ts';
export { checkLockfile } from './lockfile.ts';
export { outputDigest } from './output-digest.ts';
export { checkPin, pinDigest } from './pin-digest.ts';
export { readPinList, type BaseEntry, type PinList, type SiteEntry } from './pin-list.ts';
export { forwardBytes, forwardLoadHead } from './proxy-forward.ts';
export {
  type More,
  type ProxyRead,
  readProxyRequest,
  type ContainerAction,
  type ProxyGrammar,
  type ProxyOp,
} from './proxy-request.ts';
export {
  readReason,
  REASONS,
  type Reason,
  type Refused,
  type SandboxResult,
  type Why,
} from './refusal.ts';
export { s1Env, s2Env } from './run-env.ts';
export { runOutcome, type RunEnd, type RunOutcome } from './run-outcome.ts';
export { readSiteRecord, type SiteRecord } from './site-record.ts';
export { parseStrictJson, type Json } from './strict-json.ts';
export {
  OUTPUT_CAP,
  readOutput,
  type OutputGrammar,
  type OutputRead,
  type TarEntry,
  UstarReader,
} from './ustar-reader.ts';
