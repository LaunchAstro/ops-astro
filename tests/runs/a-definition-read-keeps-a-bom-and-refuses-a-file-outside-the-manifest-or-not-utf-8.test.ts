// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P3 (design v3, guards R4 and R5): `definition.read` answers only a
// file the run's manifest names, and only one that is UTF-8. A file outside
// the manifest (it is in the instruction folder) is refused with no ledger
// row; a file that is not UTF-8 is refused with no ledger row, kept copy or
// audit event. A file that starts with a byte order mark reads with U+FEFF
// first, and a turn made from it binds and sends the mark.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { signedIn } from './run-stop-door-world.ts';
import {
  bytesOf,
  carriesNoText,
  definitionPart,
  encode,
  freshFile,
  ledgerOf,
  pinnedWork,
  read,
  readBody,
  readOk,
  useDefinitionWorld,
  wroteNothing,
} from './definition-world.ts';
import { sendTurn, settledOnce, systemOf } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

const BOM = [0xef, 0xbb, 0xbf];

const withBom = (text: string): Uint8Array => Uint8Array.from([...BOM, ...encode(text)]);

/** A file with a byte that starts no UTF-8 sequence, and a uuid of its own. */
const notUtf8 = (): Uint8Array =>
  Uint8Array.from([...encode(`# Latin-1 ${randomUUID()}\n`), 0xe9, 0x0a]);

describe.skipIf(serverUrl === undefined)('a definition read', () => {
  useDefinitionWorld('defbytes');

  it('a: refuses a path outside the manifest, with no ledger row', async () => {
    const outside = freshFile('# Not in the manifest\n');
    const on = await pinnedWork('definition read outside the manifest');
    // Mutation: drop readPinned's manifest check -> served, red.
    const answer = await read(on, readBody(on, outside), await signedIn());
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('DEFINITION_DIGEST_MISMATCH');
    carriesNoText(answer, outside);
    expect(await ledgerOf(on.runId)).toBe(0);
  }, 60_000);

  it('b: refuses a file that is not UTF-8, with no ledger row, copy or event', async () => {
    const path = freshFile('', notUtf8());
    const on = await pinnedWork('definition read not utf-8', [path]);
    const body = readBody(on, path);
    // Mutation: drop both `fatal` and the round trip (the pair) -> served with U+FFFD, red.
    const answer = await read(on, body, await signedIn());
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('DEFINITION_DIGEST_MISMATCH');
    expect(answer.body['detail'] ?? {}).not.toHaveProperty('text');
    await wroteNothing(on, path, body.operationId);
  }, 60_000);

  it('c: reads a file that starts EF BB BF with U+FEFF first, and its turn binds', async () => {
    const path = freshFile('', withBom(`# Byte order mark\n${randomUUID()}\n`));
    const on = await pinnedWork('definition read bom', [path]);
    const as = await signedIn();
    // Mutation: drop `ignoreBOM` -> the round trip refuses the genuine file, red.
    const detail = await readOk(on, as, path);
    const text = String(detail['text']);
    expect(text.codePointAt(0)).toBe(0xfe_ff);
    expect(Buffer.from(text, 'utf8').equals(Buffer.from(bytesOf(path)))).toBe(true);
    const turn = await sendTurn(on, [definitionPart(path), await taskPart(on.work)], as);
    settledOnce(turn);
    expect(String(systemOf(turn)?.['text']).codePointAt(0)).toBe(0xfe_ff);
  }, 60_000);
});
