// SPDX-License-Identifier: AGPL-3.0-only
//
// How an agent call ends when it does not apply is how a person's does: one
// `settle`, in the envelope (`envelope.ts`), which writes the register row and
// the audit row for a refusal on either prefix. Re-exported here so the agent
// path's own name for it stays the same one function.

export { settle } from './envelope.ts';
