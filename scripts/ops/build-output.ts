// SPDX-License-Identifier: AGPL-3.0-only
//
// The build output's Sydney check (ticket S0-6, `S0-6 functions in Sydney`).
//
// The web app and its API go to Vercel as a build output in its Build Output
// API layout, version 3: `config.json`, `static/`, and each function as a
// `<name>.func` directory under `functions/` with its `.vc-config.json`. The
// owner's condition is that client data is handled in Australia, so every
// function must be a Node function pinned to `syd1` and nothing else:
//
// - no edge runtime and no middleware, which run on the edge network wherever
//   the request lands;
// - no prerendered route (`.prerender-config.json`), which that network keeps;
// - no symlink under `functions/`, inside a function's bundle included, so
//   each function read is the one deployed.
//
// A `config.json` shape it does not recognise (a key other than `version` and
// `routes`, or routes that are not a list of objects) is a problem too.
//
// `buildOutputProblems` reads the directory and answers every problem it
// finds, in plain words and naming paths inside the output only; an empty list
// is the one passing answer. Nothing it cannot read is taken as passing.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** A Node.js runtime as Vercel names one, and only that. */
const NODE_RUNTIME = /^nodejs\d+\.x$/u;
/** The keys a route may carry that put middleware in front of it. */
const MIDDLEWARE_KEYS = ['middleware', 'middlewarePath', 'middlewareRawSrc'];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function configProblems(root: string): string[] {
  const config = readJson(join(root, 'config.json'));
  if (!isRecord(config) || config['version'] !== 3) {
    return ['config.json is missing, unreadable or not version 3.'];
  }
  const routes = 'routes' in config ? config['routes'] : [];
  if (
    Object.keys(config).some((key) => key !== 'version' && key !== 'routes') ||
    !Array.isArray(routes) ||
    !routes.every((route) => isRecord(route))
  ) {
    return ['config.json has a shape this check does not recognise.'];
  }
  return routes.some((route) => isRecord(route) && MIDDLEWARE_KEYS.some((key) => key in route))
    ? ['config.json routes a request through middleware, which runs outside Sydney.']
    : [];
}

function functionProblems(func: string, name: string): string[] {
  const config = readJson(join(func, '.vc-config.json'));
  if (!isRecord(config)) return [`${name} has no readable .vc-config.json.`];
  const problems: string[] = [];
  const runtime = config['runtime'];
  if (typeof runtime !== 'string' || !NODE_RUNTIME.test(runtime) || 'entrypoint' in config) {
    problems.push(`${name} is not a Node.js function (the edge runtime runs outside Sydney).`);
  }
  const regions = config['regions'];
  if (!Array.isArray(regions) || regions.length !== 1 || regions[0] !== 'syd1') {
    problems.push(`${name} does not run in syd1 alone.`);
  }
  return problems;
}

/** Every function under `functions/`, and every problem on the way to them. */
function walk(root: string, directory: string, found: string[], problems: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = relative(root, path);
    if (entry.isSymbolicLink()) {
      problems.push(`${name} is a symlink; nothing under functions/ may be one.`);
    } else if (entry.name.endsWith('.prerender-config.json')) {
      problems.push(`${name} prerenders a route, which the edge network would keep.`);
    } else if (entry.name.endsWith('.func') && !entry.isDirectory()) {
      problems.push(`${name} is not a function directory.`);
    } else if (entry.isDirectory()) {
      if (entry.name.endsWith('.func')) {
        found.push(name);
        problems.push(...functionProblems(path, name));
      }
      walk(root, path, found, problems);
    }
  }
}

/** Every reason the build output at `root` may not deploy; empty when it may. */
export function buildOutputProblems(root: string): string[] {
  let functions: string;
  try {
    functions = join(root, 'functions');
    if (!lstatSync(functions).isDirectory()) return ['functions is not a directory.'];
  } catch {
    return ['The build output has no functions directory.'];
  }
  const found: string[] = [];
  const problems = configProblems(root);
  walk(root, functions, found, problems);
  if (found.length === 0) problems.push('The build output holds no function.');
  return problems;
}
