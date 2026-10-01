// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the sidebar chat's one-word site correction, the owner check's first
// step. Pure pieces, each tested without a document.
//
// **What reads as a request.** "Change alongside to beside on the About page"
// (or "Replace ... with ..."): one word for one word, on a named page. Two
// words, or no page, is a question, and goes to the conversation as before.
// The envelope itself (one file, one line, one word) is the server's to
// refuse at request time; this only decides which path the line takes.
//
// **The desk.** Where the request goes is a `CorrectionDesk`: the live one
// sends `live_correction.request` (`correction-desks.ts`); the made-up one
// answers from a made-up page where the site's read is not joined, and says
// so by its `provenance`, which the transcript marks with the kit's mock mark.
//
// **The grant.** A request takes `run:write`. The drawer reads the person's
// grants (`session.capabilities`) before either desk is asked, so a person
// without it is told so and no card is drawn; the server asks again at the
// correction's party.

import { wordAt, type AssistantCorrection } from '@launchastro/ui';
import type { Capability } from '../../../../packages/core-wire/src/index.ts';
import type { AssistantState } from './chats.ts';

export interface CorrectionAsk {
  /** The page as named, first letter raised ("About"). */
  readonly page: string;
  readonly word: string;
  readonly replacement: string;
}

/**
 * Where the word sits on the site: what `live_correction.request` takes
 * beside the two words. The `after` line is made from `before` here.
 */
export interface CorrectionTarget {
  readonly partyId: string;
  readonly taskId: string;
  readonly path: string;
  readonly pageUrl: string;
  readonly baseRevision: string;
  readonly before: string;
}

export type DeskAnswer =
  | {
      readonly kind: 'card';
      readonly correctionId: string;
      readonly correction: AssistantCorrection;
    }
  | { readonly kind: 'refused'; readonly because: string };

export interface CorrectionDesk {
  /** `mock` where the answers are made up; every line it draws is then marked. */
  readonly provenance: 'real' | 'mock';
  readonly request: (ask: CorrectionAsk) => Promise<DeskAnswer>;
  /** The decision as it stands now; absent where no read reaches it from here. */
  readonly recheck?: (correctionId: string) => Promise<DeskAnswer>;
}

export const RUN_WRITE = { collection: 'run', action: 'write' } as const;

export const NOT_GRANTED =
  'Nothing was requested: a change to the site takes run:write, and you do not hold it.';

export const holdsRunWrite = (grants: readonly Capability[]): boolean =>
  grants.some(
    (grant) => grant.collection === RUN_WRITE.collection && grant.action === RUN_WRITE.action,
  );

const ASK =
  /^\s*(?:please\s+)?(?:change|replace|swap)\s+["'“‘]?([\p{L}\p{N}’'-]+)["'”’]?\s+(?:to|with|for)\s+["'“‘]?([\p{L}\p{N}’'-]+)["'”’]?\s+on\s+(?:the\s+|our\s+)?([\p{L}\p{N}][\p{L}\p{N} -]{0,40}?)\s+page\s*[.!]?\s*$/iu;

const raised = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

export function readCorrectionAsk(text: string): CorrectionAsk | null {
  const found = ASK.exec(text);
  const [, word, replacement, page] = found ?? [];
  if (word === undefined || replacement === undefined || page === undefined) return null;
  if (word.toLowerCase() === replacement.toLowerCase()) return null;
  return { page: raised(page.trim()), word, replacement };
}

/** The line as it will read: the first whole `word` replaced, or null when it is not there. */
export function corrected(line: string, word: string, replacement: string): string | null {
  const at = wordAt(line, word);
  return at === -1 ? null : `${line.slice(0, at)}${replacement}${line.slice(at + word.length)}`;
}

/** A correction's card replaced in place, as a decision read again found it. */
export const amended = (
  state: AssistantState,
  key: string,
  messageId: string,
  correction: AssistantCorrection,
): AssistantState => ({
  ...state,
  chats: state.chats.map((chat) =>
    chat.key === key
      ? {
          ...chat,
          messages: chat.messages.map((message) =>
            message.id === messageId ? { ...message, correction } : message,
          ),
        }
      : chat,
  ),
});
