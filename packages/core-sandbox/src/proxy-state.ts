// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy's one
// decision point over its two durable records, kept in one file so that a
// create's container id and candidate count land in one write. A create is
// taken alone, from its count check until that write, and answered after
// it, so one the daemon made but the record never held counts nothing and
// is swept. Its image is pinned for its class (a site's only with its own
// entry's `Env`, once B8 accepted it) or, for S1 only, a pin's open
// candidate. B8 runs on every pin-list read, open included.
//
// The proxy sweeps on open, on a count mismatch and on a failed delete;
// until a sweep passes every request is `unavailable` and it repeats every
// 30 s. A run whose container a sweep removed, or answered while a failed
// sweep waits, is `unavailable`; a delete only when another sweep, passed
// or not, took it. A throw in a request answers `internal`; in the timer or a note it
// leaves the record for the next tick. A wait counts only after a 204 start
// and is judged when it lands; an attach once its start was sent and a
// start at the deadline are refused. `tick` kills at every tick from the
// deadline, latched against a clock step back (a container held across a
// restart is past it), and deletes when P4 and P6 say so, its daemon calls
// without the lock. Loads and image calls are P5's (piece 2d-ii).

import {
  candidateCreate,
  type CandidateBook,
  countCandidateCreate,
  EMPTY_BOOK,
  pinnedFor,
  readDeployed,
  recordCandidateWait,
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
type Note = (book: ContainerBook, now: number) => ContainerBook;
type Landed = { readonly started: boolean; readonly at: number; readonly late: boolean };
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

const deleteAnswer = (status: number): DeleteAnswer =>
  status === NO_CONTENT ? 'removed' : status === NOT_FOUND ? 'no such container' : 'failed';

export class ProxyState {
  readonly #ports: ProxyPorts;
  #candidates: CandidateBook;
  #containers: ContainerBook;
  #lock: Promise<unknown> = Promise.resolve();
  /** While no sweep has passed: when to sweep again. */
  #retryAt: number | null = null;
  /** Recorded ids a sweep set out to remove, passed or not; a run on one is `unavailable`. */
  readonly #swept = new Set<string>();
  /** The last id whose start was sent; an attach to it comes too late (P4). */
  #startSent: string | null = null;
  /** The last id whose start the daemon answered 204. */
  #started: string | null = null;
  /** The recorded id whose deadline came, whatever the clock says after; or held at a restart. */
  #expired: string | null;
  /** The recorded container's counted candidate run, if it is one. */
  #run: { readonly image: string; readonly run: number } | null = null;

  private constructor(ports: ProxyPorts, record: ProxyRecord) {
    this.#ports = ports;
    this.#candidates = record.candidates;
    this.#containers = record.containers;
    this.#expired = record.containers.container?.id ?? null;
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

  /** A launcher request; a throw anywhere on its path (daemon or store) answers `internal`. */
  handle(op: StateOp): Promise<SandboxResult<{ reply: Reply }>> {
    const answer =
      op.kind === 'create' ? this.#exclusive(() => this.#create(op)) : this.#operate(op);
    return answer.catch(() => fault('reply status'));
  }

  async #operate(op: Exclude<StateOp, CreateOp>): Promise<SandboxResult<{ reply: Reply }>> {
    if (this.#retryAt !== null) return UNAVAILABLE;
    if ('id' in op) {
      if (this.#swept.has(op.id)) return UNAVAILABLE;
      const admitted = admitContainerOp(this.#containers, op.id);
      if (!admitted.ok) return admitted;
      if (op.kind === 'start' && this.#reached(op.id, this.#ports.now())) return refuse('deadline');
      if (op.kind === 'attach' && this.#startSent === op.id) return refuse('run order');
      if (op.kind === 'start') this.#startSent = op.id;
    }
    const started = 'id' in op && this.#started === op.id;
    const reply = await this.#call(op);
    if (op.kind === 'start' && reply.status === NO_CONTENT) this.#started = op.id;
    const at = this.#ports.now();
    if (op.kind === 'wait') {
      const late = this.#reached(op.id, at);
      await this.#exclusive(() => this.#waited(op.id, reply, { started, at, late }));
    }
    if (op.kind === 'delete') {
      if (await this.#exclusive(() => this.#deleted(op.id, reply))) return UNAVAILABLE;
    } else if (this.#retryAt !== null || ('id' in op && this.#swept.has(op.id))) return UNAVAILABLE;
    return reply === THREW ? fault('reply status') : { ok: true, reply };
  }

  /** The caller's timer; a throw (a dead store) leaves the record as it was for the next tick. */
  async tick(): Promise<void> {
    await this.#tick().catch(() => null);
  }

  /** A due kill, then a due sweep or delete; the daemon calls skip the lock. */
  async #tick(): Promise<void> {
    const id = this.#containers.container?.id;
    const now = this.#ports.now();
    const due = containerDue(this.#containers, now);
    if (id !== undefined && this.#reached(id, now)) await this.#call({ kind: 'kill', id });
    if (this.#retryAt !== null) {
      await this.#exclusive(async () => {
        if (this.#retryAt !== null && this.#ports.now() >= this.#retryAt) await this.#sweep();
      });
    } else if (id !== undefined && due.delete) {
      const reply = await this.#call({ kind: 'delete', id });
      await this.#exclusive(() => this.#deleted(id, reply));
    }
  }

  /** The recorded container's attach stream ended. */
  attachEnded(id: string): Promise<void> {
    return this.#note(id, (book, now) => noteAttachEnded(book, now));
  }

  /** The launcher closed the recorded container's attach connection in both directions. */
  attachClosed(id: string): Promise<void> {
    return this.#note(id, (book, now) => noteAttachClosed(book, now));
  }

  /** Whether recorded container `id` reached its deadline, latched against a clock step back. */
  #reached(id: string, now: number): boolean {
    if (containerDue(this.#containers, now).kill && this.#containers.container?.id === id)
      this.#expired = id;
    return this.#expired === id;
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

  /** A wait's answer, judged at `at`, when it landed, not when its write took the lock. */
  async #waited(id: string, reply: Reply, { started, at, late }: Landed): Promise<void> {
    const held = this.#containers.container;
    const status = reply.status === OK ? readWaitStatus(reply.body) : null;
    if (held?.id !== id || !started || status?.ok !== true || this.#retryAt !== null) return;
    const [run, code] = [this.#run, status.statusCode];
    const candidates =
      run === null
        ? this.#candidates
        : recordCandidateWait(this.#candidates, run.image, run.run, code, !late);
    await this.#save(candidates, noteWaitReturned(this.#containers, at));
  }

  /** A delete's answer; true when a sweep other than its own removed the container first. */
  async #deleted(id: string, reply: Reply): Promise<boolean> {
    if (this.#containers.container?.id !== id || this.#swept.has(id)) return this.#swept.has(id);
    const after = deleteAnswered(this.#containers, deleteAnswer(reply.status));
    if (after.sweep) await this.#sweep();
    else await this.#save(this.#candidates, after.book);
    return false;
  }

  /** A note timed when reported, not when its write takes the lock; a dead store drops it. */
  async #note(id: string, step: Note): Promise<void> {
    const at = this.#ports.now();
    await this.#exclusive(async () => {
      if (this.#containers.container?.id !== id) return;
      await this.#save(this.#candidates, step(this.#containers, at));
    }).catch(() => null);
  }

  /** P6's sweep; the held id is swept from its start. A pass clears the record; a fail repeats. */
  async #sweep(): Promise<void> {
    const held = this.#containers.container;
    if (held !== null) this.#swept.add(held.id);
    const passed = await sweep(this.#ports.daemon).catch(() => fault('sweep'));
    if (!passed.ok) {
      this.#retryAt = this.#ports.now() + SWEEP_RETRY_MS;
      return;
    }
    await this.#save(this.#candidates, EMPTY_CONTAINERS);
    this.#retryAt = null;
  }
}
