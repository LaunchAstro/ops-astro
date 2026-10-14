// SPDX-License-Identifier: AGPL-3.0-only
//
// A separate process for the P1b proofs: a second holder or a restart that
// prepares and presents, or a sign-in that judges and commits under the lock.
// It answers on IPC only and writes nothing to stdout or stderr.

import {
  signInVerdict,
  tokenHolder,
  type PlanLogKind,
} from '../../../packages/core-custody/src/plan-token.ts';
import {
  commitTokenFile,
  readTokenFileLocked,
} from '../../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../../packages/core-custody/src/token-lock.ts';
import { faultyFs, type ChildCommand, sleep } from './plan-token-world.ts';

const command = JSON.parse(process.argv[2] ?? '{}') as Exclude<ChildCommand, { op: 'hold' }>;
const send = (message: Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    process.send?.(message, () => resolve());
  });

async function main(): Promise<void> {
  if (command.op === 'prepare') {
    const started = Date.now();
    const logs: PlanLogKind[] = [];
    const holder = tokenHolder({
      file: command.file,
      tokenUrl: new URL(command.tokenUrl),
      now: () => command.at + (Date.now() - started),
      log: (kind) => logs.push(kind),
      ...(command.fault === undefined ? {} : { fs: faultyFs(command.fault) }),
    });
    const prepared = await holder.prepare();
    const presented = holder.present();
    await send({
      prepare: prepared.ok ? 'ok' : prepared.code,
      present: presented.ok ? `ok:${presented.accessToken}` : presented.code,
      logs,
    });
    return;
  }
  const record = command.record;
  const out = await withTokenLock(
    command.file,
    { deadlineAt: Date.now() + 45_000 },
    async (held) => {
      const subject = record.state === 'spent' ? record.subject : record.tokens.subject;
      const verdict = signInVerdict(readTokenFileLocked(held, command.file), subject);
      await sleep(command.holdMs);
      return {
        verdict,
        outcome: verdict === 'write' ? commitTokenFile(held, command.file, record) : 'none',
      };
    },
  );
  await send(out.held ? out.value : { refused: out.why });
}

await main();
process.disconnect();
