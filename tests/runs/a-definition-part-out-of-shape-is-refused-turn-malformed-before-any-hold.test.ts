// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P4 (design v3, "The turn, at reserve" row 7): a definition part out
// of shape is refused `TURN_MALFORMED` at reserve, before any hold or send,
// and the attempt ends. Each case's run has read its file first, so the part
// would bind but for the one check its case breaks: no `text`, a key of its
// own, a number for text, the part second, an uppercase or a 63-character
// digest, a lone surrogate where the file holds U+FFFD (its UTF-8 is the
// file's bytes), and a text of 262,145 UTF-8 bytes. Control: 262,144 binds.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn, type SignedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  encode,
  ENTRY,
  freshFile,
  pinnedWork,
  readOk,
  useDefinitionWorld,
  type Pinned,
} from './definition-world.ts';
import { beforeTurn, refusedBeforeAnyHold, sendTurn, settledOnce } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

const MOST = 262_144;

/** A file of exactly `bytes` UTF-8 bytes, ASCII, beginning with a uuid of its own. */
const sized = (bytes: number): string => {
  const head = `# ${randomUUID()}\n`;
  return freshFile('', encode(head + 'a'.repeat(bytes - head.length)));
};

/** A file holding U+FFFD, the replacement character, as three bytes EF BF BD. */
const replacement = (): string => freshFile('', encode(`# Replaced � here ${randomUUID()}\n`));

interface Case {
  readonly name: string;
  /** The file the run reads; the entry by default. */
  readonly file?: () => string;
  readonly parts: (on: Pinned, path: string) => Promise<readonly unknown[]>;
}

const task = async (on: Pinned): Promise<Record<string, unknown>> => await taskPart(on.work);

const CASES: readonly Case[] = [
  {
    // Mutation: the shape check accepts a part without `text` -> not TURN_MALFORMED, red.
    name: 'a: no text',
    parts: async (on, path) => {
      const { text: _text, ...part } = definitionPart(path);
      return [part, await task(on)];
    },
  },
  {
    // Mutation: drop the exact-keys check -> binds, red.
    name: 'b: an extra key',
    parts: async (on, path) => [definitionPart(path, { note: 'extra' }), await task(on)],
  },
  {
    // Mutation: drop the string check on `text` -> not TURN_MALFORMED, red.
    name: 'c: a number for text',
    parts: async (on, path) => [definitionPart(path, { text: 42 }), await task(on)],
  },
  {
    // Mutation: a definition accepted after part 0 -> binds, red.
    name: 'd: the definition as part 1',
    parts: async (on, path) => [await task(on), definitionPart(path)],
  },
  {
    // Mutation: drop the digest shape -> PROVENANCE_UNBOUND, red.
    name: 'e: an uppercase digest',
    parts: async (on, path) => {
      const part = definitionPart(path);
      return [{ ...part, digest: String(part['digest']).toUpperCase() }, await task(on)];
    },
  },
  {
    // Mutation: drop the digest shape -> PROVENANCE_UNBOUND, red.
    name: 'e: a 63-character digest',
    parts: async (on, path) => {
      const part = definitionPart(path);
      return [{ ...part, digest: String(part['digest']).slice(0, 63) }, await task(on)];
    },
  },
  {
    // Mutation: drop `text.isWellFormed()` -> its UTF-8 is the file's, so it binds, red.
    name: 'f: a lone surrogate where the file has U+FFFD',
    file: replacement,
    parts: async (on, path) => {
      const part = definitionPart(path);
      return [{ ...part, text: String(part['text']).replace('�', '\uD800') }, await task(on)];
    },
  },
  {
    // Mutation: drop the 262,144-byte bound -> binds, red.
    name: 'g: 262,145 bytes',
    file: () => sized(MOST + 1),
    parts: async (on, path) => [definitionPart(path), await task(on)],
  },
];

async function readFirst(file: (() => string) | undefined): Promise<{
  readonly on: Pinned;
  readonly path: string;
  readonly as: SignedIn;
}> {
  const path = file?.() ?? ENTRY;
  const on = await pinnedWork(`definition out of shape ${path}`, [path]);
  const as = await signedIn();
  await readOk(on, as, path);
  return { on, path, as };
}

describe.skipIf(serverUrl === undefined)('a definition part out of shape', () => {
  useDefinitionWorld('defshape');

  it.each(CASES)(
    '$name: refused TURN_MALFORMED before any hold',
    async ({ file, parts }) => {
      const { on, path, as } = await readFirst(file);
      const before = await beforeTurn(on);
      const sent = await sendTurn(on, await parts(on, path), as);
      await refusedBeforeAnyHold(on, sent, 'TURN_MALFORMED', before);
    },
    60_000,
  );

  it('g: control, 262,144 bytes binds and settles', async () => {
    const { on, path, as } = await readFirst(() => sized(MOST));
    expect(Buffer.byteLength(String(definitionPart(path)['text']), 'utf8')).toBe(MOST);
    // Mutation: the bound off by one (fewer than 262,144) -> refused, red.
    settledOnce(await sendTurn(on, [definitionPart(path), await taskPart(on.work)], as));
  }, 60_000);
});
