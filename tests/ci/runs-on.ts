// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-LOCAL: each job's `runs-on`, as GitHub evaluates it, for tests/ci/merge-group-runner.test.ts.
// The route reads two values: the event, which GitHub sets, and the repository variable
// OPS_CI_LOCAL, which only a repository admin sets. Anything else in a `runs-on` is refused, so a
// route cannot read a value a pull request controls (a branch name, a title) or lean on a function
// this does not model. Semantics per
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions: && and || return
// an operand, not a boolean; strings compare without case; a missing value is null.

import { parseDocument } from 'yaml';
import { read } from './merge-group-repo.ts';

export type Value = string | boolean | null | Value[];
export type Ctx = { event: string; on: string | undefined };

export const LOCAL: string[] = ['self-hosted', 'ops-merge-m5'];
export const HOSTED: ReadonlySet<string> = new Set(['ubuntu-latest', 'ubuntu-24.04']);
/** Every event a workflow here starts on, and the ones a fork's pull request can bring. */
export const EVENTS: string[] = [
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'issue_comment',
  'workflow_run',
  'push',
  'merge_group',
  'schedule',
  'workflow_dispatch',
];
/** The variable unset, empty, on in two cases, and values someone might mean as on. */
export const SWITCH: (string | undefined)[] = [
  undefined,
  '',
  'on',
  'ON',
  'off',
  'true',
  '1',
  'on ',
];
const isOn = (v: string | undefined) => v?.toLowerCase() === 'on';

const truthy = (v: Value) => v !== null && v !== false && v !== '';
const equal = (a: Value, b: Value) =>
  typeof a === 'string' && typeof b === 'string'
    ? a.toLowerCase() === b.toLowerCase()
    : JSON.stringify(a) === JSON.stringify(b);

class Expression {
  private readonly tokens: string[];
  private readonly source: string;
  private readonly ctx: Ctx;
  private i = 0;

  constructor(source: string, ctx: Ctx) {
    this.source = source;
    this.ctx = ctx;
    this.tokens = source.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[!(),]|[A-Za-z_][\w.-]*|\S/gu) ?? [];
  }

  value(): Value {
    const v = this.or();
    if (this.i !== this.tokens.length) throw new Error(`unread tail in ${this.source}`);
    return v;
  }

  private peek = () => this.tokens[this.i];

  private take(want?: string): string {
    const t = this.tokens[this.i++];
    if (t === undefined || (want !== undefined && t !== want)) {
      throw new Error(`expected ${want ?? 'a token'} in ${this.source}`);
    }
    return t;
  }

  private or(): Value {
    let v = this.and();
    while (this.peek() === '||') {
      this.take();
      const right = this.and();
      v = truthy(v) ? v : right;
    }
    return v;
  }

  private and(): Value {
    let v = this.comparison();
    while (this.peek() === '&&') {
      this.take();
      const right = this.comparison();
      v = truthy(v) ? right : v;
    }
    return v;
  }

  private comparison(): Value {
    const left = this.unary();
    if (this.peek() !== '==' && this.peek() !== '!=') return left;
    const op = this.take();
    const same = equal(left, this.unary());
    return op === '==' ? same : !same;
  }

  private unary(): Value {
    if (this.peek() !== '!') return this.primary();
    this.take();
    return !truthy(this.unary());
  }

  private primary(): Value {
    const t = this.take();
    if (t === '(') {
      const v = this.or();
      this.take(')');
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (t.toLowerCase() === 'fromjson' && this.peek() === '(') return this.fromJSON();
    if (t.toLowerCase() === 'github.event_name') return this.ctx.event;
    if (t.toLowerCase() === 'vars.ops_ci_local') return this.ctx.on ?? null;
    throw new Error(`a runs-on reads ${t}, which the route may not: ${this.source}`);
  }

  private fromJSON(): Value {
    this.take('(');
    const arg = this.or();
    this.take(')');
    if (typeof arg !== 'string') throw new Error(`fromJSON of a non-string in ${this.source}`);
    return JSON.parse(arg) as Value;
  }
}

export const evaluate = (source: string, ctx: Ctx): Value => new Expression(source, ctx).value();

function expressionLabels(runsOn: string, ctx: Ctx): string[] | string {
  const whole = /^\$\{\{([\s\S]*)\}\}$/u.exec(runsOn.trim());
  if (whole === null) return runsOn.includes('${{') ? `a partial expression: ${runsOn}` : [runsOn];
  const v = evaluate(whole[1] ?? '', ctx);
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return `runs-on is ${JSON.stringify(v)}`;
}

/** The labels a job asks for under `ctx`, or why they cannot be read. */
export function labels(runsOn: unknown, ctx: Ctx): string[] | string {
  try {
    if (typeof runsOn === 'string') return expressionLabels(runsOn, ctx);
    if (Array.isArray(runsOn) && runsOn.every((x) => typeof x === 'string' && !x.includes('${{'))) {
      return runsOn as string[];
    }
    // The `{ group, labels }` form picks a runner group by name; the route never does.
    return `runs-on unread: ${JSON.stringify(runsOn)}`;
  } catch (error) {
    return (error as Error).message;
  }
}

export type Job = { file: string; id: string; name: string; needs: string[]; runsOn: unknown };

function fileJobs(file: string, text: string, errors: string[]): Job[] {
  const doc = parseDocument(text, { merge: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    errors.push(...doc.errors.map((e) => `${file}: ${e.message}`));
    return [];
  }
  const all = (doc.toJS({ maxAliasCount: 100 }) as { jobs?: unknown }).jobs;
  if (typeof all !== 'object' || all === null) {
    errors.push(`${file}: no jobs map`);
    return [];
  }
  return Object.entries(all as Record<string, Record<string, unknown>>).map(([id, job]) => {
    const raw = job?.['needs'];
    const needs = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map((n) =>
      String(n).toLowerCase(),
    );
    const name = typeof job?.['name'] === 'string' ? job['name'] : id;
    return { file, id: id.toLowerCase(), name, needs, runsOn: job?.['runs-on'] };
  });
}

/** Every job in every workflow given (path to text); a parse error is reported, not skipped. */
export function readJobs(texts: Map<string, string>): { jobs: Job[]; errors: string[] } {
  const errors: string[] = [];
  const jobs = [...texts].flatMap(([file, text]) => fileJobs(file, text, errors));
  return { jobs, errors };
}

export const required: ReadonlySet<string> = new Set(
  (
    JSON.parse(read('.github/required-checks.json')) as {
      required_status_checks: { context: string }[];
    }
  ).required_status_checks.map((c) => c.context),
);

/** The jobs that report a required check, and every job they wait on, as `file id`. */
export function behindRequired(jobs: Job[]): Set<string> {
  const out = new Set<string>();
  const todo = jobs.filter((j) => required.has(j.name));
  for (let j = todo.pop(); j !== undefined; j = todo.pop()) {
    const key = `${j.file} ${j.id}`;
    if (out.has(key)) continue;
    out.add(key);
    todo.push(...jobs.filter((k) => k.file === j.file && j.needs.includes(k.id)));
  }
  return out;
}

function jobProblems(job: Job, mustRoute: boolean): string[] {
  const where = `${job.file}: ${job.name}`;
  const problems: string[] = [];
  for (const event of EVENTS) {
    for (const on of SWITCH) {
      const got = labels(job.runsOn, { event, on });
      const when = `${event}, OPS_CI_LOCAL=${JSON.stringify(on)}`;
      if (typeof got === 'string') {
        problems.push(`${where}: ${got}`);
        continue;
      }
      const local = JSON.stringify(got) === JSON.stringify(LOCAL);
      const hosted = got.length === 1 && HOSTED.has(got[0] ?? '');
      const wantLocal = mustRoute && event === 'merge_group' && isOn(on);
      if (!local && !hosted) problems.push(`${where}: on ${when} asks for ${got.join(',')}`);
      else if (local && !wantLocal) problems.push(`${where}: reaches the M5 on ${when}`);
      else if (hosted && wantLocal) problems.push(`${where}: stays hosted on ${when}`);
    }
  }
  return problems;
}

/**
 * Every way the workflows break the route: a job that reaches a runner other than a hosted one or
 * the M5's merge-queue labels; the M5 reached on any event but a merge group, or with the switch
 * off; a required job, or one it waits on, left on hosted runners in a merge group with the switch
 * on; a job outside that set sent to the M5; a required check no job reports; anything unreadable.
 * Empty when the route is sound.
 */
export function routeProblems(texts: Map<string, string>): string[] {
  const { jobs, errors } = readJobs(texts);
  const behind = behindRequired(jobs);
  const missing = [...required]
    .filter((c) => c !== 'DCO' && !jobs.some((j) => j.name === c))
    .map((c) => `no job reports the required check '${c}'`);
  const routes = jobs.flatMap((j) => jobProblems(j, behind.has(`${j.file} ${j.id}`)));
  return [...new Set([...errors, ...missing, ...routes])];
}
