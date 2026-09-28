// SPDX-License-Identifier: AGPL-3.0-only
//
// The payload digest's one way in: the canonical form of a request payload
// and its hash, which the server binds replays and decisions to and the
// command line computes the same way. It imports nothing of the product. It
// is its own package, apart from the wire contract, because it needs
// `node:crypto` and the web, which takes the wire contract, must not load it.

export { canonicalPayload, payloadDigest } from './digest.ts';
