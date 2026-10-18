// SPDX-License-Identifier: AGPL-3.0-only
//
// A planted backup store that answers the drill's reads as the real one does
// (deploy/staging/backup-store-upgrade-3.sql): the header, each part sealed
// under a key of its own (`backups.read_part`), and that key once
// (`backups.release_part`), each told apart by its script. It takes every
// script whole, as psql does, so an ask made as the script is taken runs.

import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export type Script = string | Iterable<string> | AsyncIterable<string>;
export type Header = { id: string; takenAt: string; bytes: number; parts: number; sha256: string };
export type Taken = 'header' | 'part' | 'release';

const PART = 4 * 1024 * 1024;
const digestOf = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

async function whole(script: Script): Promise<string> {
  if (typeof script === 'string') return script;
  let text = '';
  for await (const piece of script) text += piece;
  return text;
}

/**
 * The store's answers for `header` over `body`; `taken` is told of each
 * script as it is taken, and `printing` just before each line it prints.
 */
export function twoPhaseStore(
  header: Header,
  body: Buffer,
  {
    taken = () => {},
    printing = () => {},
  }: { taken?: (what: Taken) => void; printing?: (what: Taken) => void } = {},
): (url: string, script: Script, onLine?: (line: string) => unknown) => Promise<string> {
  const keys = new Map<number, Buffer>();
  return async (_url, script, onLine) => {
    const text = await whole(script);
    const [, step, number] = /backups\.(read_part|release_part)\(.*?, (\d+)\)/u.exec(text) ?? [];
    const what: Taken =
      step === 'release_part' ? 'release' : step === 'read_part' ? 'part' : 'header';
    const seq = Number(number);
    taken(what);
    let line: string | undefined;
    if (what === 'header') line = JSON.stringify(header);
    if (what === 'part') {
      const part = body.subarray(seq * PART, (seq + 1) * PART);
      const key = randomBytes(32);
      keys.set(seq, key);
      const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const sealed = Buffer.concat([cipher.update(part), cipher.final()]);
      line = `${seq}|${digestOf(part)}|${sealed.toString('hex')}`;
    }
    if (what === 'release') {
      const key = keys.get(seq);
      keys.delete(seq);
      if (key === undefined) throw new Error('the store refused');
      line = key.toString('hex');
    }
    printing(what);
    if (onLine === undefined) return line ?? '';
    if (line !== undefined) await onLine(line);
    return '';
  };
}
