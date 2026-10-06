// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy's one
// decision point over its two durable records, both in one file so that a
// create's container id and its candidate count land in one write.
//
// A create is taken one at a time, from its count check until the returned
// id is durable, and answered only after that write: a create the daemon
// made but the proxy never recorded counts nothing and is swept at the next
// start or count check. Its image is one the pin list holds for its class,
// a site image only with its own entry's `Env` and only once B8 accepted it,
// or, for the S1 body only, the open candidate of a pin being made. B8 runs
// on every read of the pin list, start included.
//
// The proxy sweeps on start before it takes a request, on a failed count
// check and on a failed delete of its recorded container. While no sweep
// has passed every request is `unavailable`, and the sweep repeats every
// 30 s; a run whose container a sweep removed stays `unavailable`. A throw
// fails a sweep or delete and answers the launcher `internal`. A wait counts
// only if sent after a start answered 204 (a created container's wait
// answers at once), and a start at the deadline is refused. `tick` is the
// caller's timer: it kills at every tick from the deadline until the record
// clears, whatever any answer, and deletes when P4 and P6 say so. Loads and
// image calls are P5's (piece 2d-ii).

import {
  candidateCreate,
  type CandidateBook,
  countCandidateCreate,
  EMPTY_BOOK,
  readDeployed,
  recordCandidateWait,
  sameList,
} from './candidate-book.ts';
import {
  admitContainerCreate,
  admitContainerOp,
  type ContainerBook,
  containerDue,
  type DeleteAnswer,
  deleteAnswered,
  EMPTY_CONTAINERS,
  noteAttachClosed,
  noteAttachEnded,
  noteWaitReturned,
  recordContainer,
} from './container-book.ts';
import type { CreateShape } from './create-body.ts';
import { readContainerCount, readCreatedId, readWaitStatus } from './daemon-reply.ts';
import { type PinList, readPinList } from './pin-list.ts';
import type { ProxyOp } from './proxy-request.ts';
import { type ProxyRecord, readProxyRecord, writeProxyRecord } from './proxy-record.ts';
import { fault, refuse, type SandboxResult, unavailable } from './refusal.ts';
import { sweep, SWEEP_RETRY_MS, type SweepDaemon } from './sweep.ts';

type Reply = { readonly status: number; readonly body: Uint8Array };
/** The operations this flow decides: everything but P5's loads and image calls (piece 2d-ii). */
export type StateOp = Exclude<ProxyOp, { kind: 'load' | 'image-inspect' | 'image-delete' }>;
type CreateOp = Extract<StateOp, { kind: 'create' }>;
export type ProxyPorts = {
  /** The one file holding both records; `read` gives null before the first write. */
  readonly store: {
    readonly read: () => Promise<Uint8Array | null>;
    readonly write: (bytes: Uint8Array) => Promise<void>;
  };
  /** The deployed pin list as the deploy wrote it. */
  readonly pins: () => Promise<Uint8Array>;
  /** The sweep's three calls, and every other operation rebuilt from its checked form. */
  readonly daemon: SweepDaemon & { readonly forward: (op: StateOp) => Promise<Reply> };
  /** Wall time in ms. */
  readonly now: () => number;
};

/** B6's wall clock per built class; a probe runs under the class it probes. */
const WALL_MS = { 'site.build': 120_000, 'site.prepare': 600_000 } as const;
const [OK, CREATED, NO_CONTENT, NOT_FOUND] = [200, 201, 204, 404];
const UNAVAILABLE = unavailable('sweep');
const THREW: Reply = { status: 0, body: new Uint8Array() };

/** Whether the pin list holds `image` for this create's class and, for a site, its `Env`. */
function pinnedFor(pins: PinList, shape: CreateShape, image: string): boolean {
  if (shape.runClass === 'probe') return image === pins.probe;
  const entries = shape.runClass === 'site.build' ? pins.sites.values() : pins.base.values();
  return [...entries].some((entry) => entry.image === image && sameList(entry.env, shape.env));
}

const deleteAnswer = (status: number): DeleteAnswer =>
  status === NO_CONTENT ? 'removed' : status === NOT_FOUND ? 'no such container' : 'failed';

export class ProxyState {
  readonly #ports: ProxyPorts;
  #candidates: CandidateBook;
  #containers: ContainerBook;
  #lock: Promise<unknown> = Promise.resolve();
  /** While no sweep has passed: when to sweep again. */
  #retryAt: number | null = null;
  /** Recorded ids a sweep removed; a run on one is `unavailable`. */
  readonly #swept = new Set<string>();
  /** The last id whose start the daemon answered 204. */
  #started: string | null = null;
  /** The recorded container's counted candidate run, if it is one. */
  #run: { readonly image: string; readonly run: number } | null = null;

  private constructor(ports: ProxyPorts, record: ProxyRecord) {
    this.#ports = ports;
    this.#candidates = record.candidates;
    this.#containers = record.containers;
  }

  /** Reads the record, applies B8 to the pin list and sweeps, before any request. */
  static async open(ports: ProxyPorts): Promise<SandboxResult<{ state: ProxyState }>> {
    const bytes = await ports.store.read();
    const read =
      bytes === null
        ? { ok: true as const, record: { candidates: EMPTY_BOOK, containers: EMPTY_CONTAINERS } }
        : readProxyRecord(bytes);
    if (!read.ok) return read;
    const state = new ProxyState(ports, read.record);
    await state.#exclusive(async () => {
      await state.#readPins();
      await state.#sweep();
    });
    return { ok: true, state };
  }

  async handle(op: StateOp): Promise<SandboxResult<{ reply: Reply }>> {
    if (op.kind === 'create') return this.#exclusive(() => this.#create(op));
    if (this.#retryAt !== null) return UNAVAILABLE;
    if ('id' in op) {
      if (this.#swept.has(op.id)) return UNAVAILABLE;
      const admitted = admitContainerOp(this.#containers, op.id);
      if (!admitted.ok) return admitted;
      const deadline = this.#containers.container?.deadline ?? 0;
      if (op.kind === 'start' && this.#ports.now() >= deadline) return refuse('deadline');
    }
    const started = 'id' in op && this.#started === op.id;
    const reply = await this.#call(op);
    if (op.kind === 'start' && reply.status === NO_CONTENT) this.#started = op.id;
    if (op.kind === 'wait') await this.#exclusive(() => this.#waited(op.id, started, reply));
    if (op.kind === 'delete') await this.#exclusive(() => this.#deleted(op.id, reply));
    return reply === THREW ? fault('reply status') : { ok: true, reply };
  }

  /** The caller's timer: a due kill first, whatever else is pending, then a due sweep or delete. */
  tick(): Promise<void> {
    return this.#exclusive(async () => {
      const id = this.#containers.container?.id;
      const due = containerDue(this.#containers, this.#ports.now());
      if (id !== undefined && due.kill) await this.#call({ kind: 'kill', id });
      if (this.#retryAt !== null) {
        if (this.#ports.now() >= this.#retryAt) await this.#sweep();
      } else if (id !== undefined && due.delete) {
        await this.#deleted(id, await this.#call({ kind: 'delete', id }));
      }
    });
  }

  /** The recorded container's attach stream ended. */
  attachEnded(id: string): Promise<void> {
    return this.#note(id, (book, now) => noteAttachEnded(book, now));
  }

  /** The launcher closed the recorded container's attach connection in both directions. */
  attachClosed(id: string): Promise<void> {
    return this.#note(id, (book, now) => noteAttachClosed(book, now));
  }

  /** A forwarded call; a throw reads as an answer no rule accepts. */
  #call(op: StateOp): Promise<Reply> {
    return this.#ports.daemon.forward(op).catch(() => THREW);
  }

  /** Runs `step` alone: no other create, record change or sweep interleaves with it. */
  #exclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(step);
    this.#lock = run.catch(() => null);
    return run;
  }

  /** Writes both books, then holds them: memory never runs ahead of the file. */
  async #save(candidates: CandidateBook, containers: ContainerBook): Promise<void> {
    await this.#ports.store.write(writeProxyRecord({ candidates, containers }));
    this.#candidates = candidates;
    this.#containers = containers;
  }

  /** The pin list with B8 applied to its site entries, the book's change written. */
  async #readPins(): Promise<SandboxResult<{ pins: PinList }>> {
    const read = readPinList(await this.#ports.pins());
    if (!read.ok) return read;
    const deployed = readDeployed(this.#candidates, read.pins.sites);
    await this.#save(deployed.book, this.#containers);
    return { ok: true, pins: { ...read.pins, sites: deployed.sites } };
  }

  async #create(op: CreateOp): Promise<SandboxResult<{ reply: Reply }>> {
    if (this.#retryAt !== null) return UNAVAILABLE;
    const read = await this.#readPins();
    if (!read.ok) return read;
    const pinned = pinnedFor(read.pins, op.shape, op.image);
    if (!pinned && op.shape.runClass !== 'site.build') return refuse('image id');
    const candidate = pinned
      ? null
      : candidateCreate(this.#candidates, read.pins.sites, op.shape, op.image);
    if (candidate !== null && !candidate.ok) return candidate;
    const info = await this.#ports.daemon.info();
    const count = info.status === OK ? readContainerCount(info.body) : null;
    const admitted = admitContainerCreate(this.#containers, count?.ok ? count.containers : -1);
    if (!admitted.ok) {
      if (admitted.why === 'container count') await this.#sweep();
      return admitted;
    }
    const reply = await this.#ports.daemon.forward(op);
    if (reply.status !== CREATED) return { ok: true, reply };
    const made = readCreatedId(reply.body);
    if (!made.ok) {
      await this.#sweep();
      return made;
    }
    const { shape } = op;
    const wallMs = WALL_MS[shape.runClass === 'probe' ? shape.probed : shape.runClass];
    const wall = shape.runClass === 'probe' && shape.crossing === 'wall';
    const candidates =
      candidate === null ? this.#candidates : countCandidateCreate(this.#candidates, op.image);
    const now = this.#ports.now();
    await this.#save(candidates, recordContainer(this.#containers, made.id, now, wallMs, wall));
    const runs = candidates.candidates.findLast((held) => held.id === op.image)?.runs.length;
    this.#run =
      candidate === null || runs === undefined ? null : { image: op.image, run: runs - 1 };
    return { ok: true, reply };
  }

  async #waited(id: string, started: boolean, reply: Reply): Promise<void> {
    const held = this.#containers.container;
    const status = reply.status === OK ? readWaitStatus(reply.body) : null;
    if (held?.id !== id || !started || status?.ok !== true) return;
    const [now, run, code] = [this.#ports.now(), this.#run, status.statusCode];
    const candidates =
      run === null
        ? this.#candidates
        : recordCandidateWait(this.#candidates, run.image, run.run, code, now < held.deadline);
    await this.#save(candidates, noteWaitReturned(this.#containers, now));
  }

  async #deleted(id: string, reply: Reply): Promise<void> {
    if (this.#containers.container?.id !== id) return;
    const after = deleteAnswered(this.#containers, deleteAnswer(reply.status));
    await this.#save(this.#candidates, after.book);
    if (after.sweep) await this.#sweep();
  }

  #note(id: string, step: (book: ContainerBook, now: number) => ContainerBook): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#containers.container?.id !== id) return;
      await this.#save(this.#candidates, step(this.#containers, this.#ports.now()));
    });
  }

  /** P6's sweep: on a pass the container record clears; on a failure it repeats in 30 s. */
  async #sweep(): Promise<void> {
    const passed = await sweep(this.#ports.daemon).catch(() => fault('sweep'));
    if (!passed.ok) {
      this.#retryAt = this.#ports.now() + SWEEP_RETRY_MS;
      return;
    }
    const held = this.#containers.container;
    if (held !== null) this.#swept.add(held.id);
    await this.#save(this.#candidates, EMPTY_CONTAINERS);
    this.#retryAt = null;
  }
}
