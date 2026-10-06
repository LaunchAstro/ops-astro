// SPDX-License-Identifier: AGPL-3.0-only
//
// The shapes the identifier cases call through: a request body, an answer
// with its exact bytes, and the person and agent calls that return one.
// Moved whole from `ident-audit-cases.ts`, which re-exports `Body` and
// `RawAnswer`, to keep that file under the line limit.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { AgentIdentity, Answer } from './world.ts';

export type Body = Readonly<Record<string, unknown>>;

/** An answer and the exact bytes it arrived as (root ruling 2 compares those). */
export interface RawAnswer extends Answer {
  readonly text: string;
}

export type PersonCall = (
  caller: { readonly token: string },
  name: CommandName,
  body: Body,
  businessKey?: string,
) => Promise<RawAnswer>;
export type AgentCall = (
  identity: AgentIdentity,
  name: CommandName,
  body: Body,
  credential?: string,
  businessKey?: string,
) => Promise<RawAnswer>;
