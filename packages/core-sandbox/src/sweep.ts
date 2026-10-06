// SPDX-License-Identifier: AGPL-3.0-only
//
// P6's sweep (docs/plan/sandbox-contract.md, section 6). It does not read
// the proxy's record, because the daemon can hold a container the proxy
// never recorded (a crash between the daemon's create and the durable
// record), and nothing else creates containers on this daemon (B9). It
// lists every container (only a 64-hex `Id` is read), force-deletes every
// listed id, where "no such container" counts as removed, lists again,
// which must be empty, and reads a zero count from `GET /info`. Any other
// answer fails it; the caller leaves the launcher `unavailable`, keeps the
// container record, and sweeps again every 30 s until one passes. Only a
// passing sweep clears the container record; the candidate record stays.

import { readContainerCount, readContainerIds } from './daemon-reply.ts';
import { fault, type SandboxResult } from './refusal.ts';

type Reply = { readonly status: number; readonly body: Uint8Array };
/** The three daemon calls a sweep makes, each answered with its status and body. */
export type SweepDaemon = {
  /** `GET /containers/json?all=1` */
  readonly list: () => Promise<Reply>;
  /** `DELETE /containers/{id}?force=1` */
  readonly remove: (id: string) => Promise<Reply>;
  /** `GET /info` */
  readonly info: () => Promise<Reply>;
};

export const SWEEP_RETRY_MS = 30_000;
const OK = 200;
const REMOVED = 204;
const NO_SUCH_CONTAINER = 404;

const listed = async (daemon: SweepDaemon): Promise<readonly string[] | null> => {
  const { status, body } = await daemon.list();
  const read = status === OK ? readContainerIds(body) : null;
  return read?.ok === true ? read.ids : null;
};

export async function sweep(daemon: SweepDaemon): Promise<SandboxResult<object>> {
  const ids = await listed(daemon);
  if (ids === null) return fault('sweep');
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- one delete at a time, in the listed order
    const { status } = await daemon.remove(id);
    if (status !== REMOVED && status !== NO_SUCH_CONTAINER) return fault('sweep');
  }
  const again = await listed(daemon);
  if (again === null || again.length > 0) return fault('sweep');
  const { status, body } = await daemon.info();
  const count = status === OK ? readContainerCount(body) : null;
  return count?.ok === true && count.containers === 0 ? { ok: true } : fault('sweep');
}
