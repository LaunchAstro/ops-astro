// SPDX-License-Identifier: AGPL-3.0-only
//
// The sandbox's grammars' one way in (docs/plan/sandbox-contract.md, ADR
// 0048). It imports nothing of the product and runs no container.

export { AttachFrames, type AttachEnd } from './attach-frames.ts';
export {
  fixedCreateBody,
  matchCreateBody,
  type CreateShape,
  type Crossing,
} from './create-body.ts';
export * from './daemon-reply.ts';
export { forwardBytes, forwardLoadHead } from './proxy-forward.ts';
export {
  type More,
  type ProxyRead,
  readProxyRequest,
  type ContainerAction,
  type ProxyGrammar,
  type ProxyOp,
} from './proxy-request.ts';
export type { Refused, Result, Why } from './refusal.ts';
export { parseStrictJson, type Json } from './strict-json.ts';
