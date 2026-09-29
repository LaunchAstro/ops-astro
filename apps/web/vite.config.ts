// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser build, the dev server, and the module-graph manifest the
// import-boundary check reads.
//
// Specification 12.3 and [ui-reference CONTRACT.md:305 rule 4] both require the
// import rule be checked on the **built module graph** rather than on source
// text, because a transitive re-export is invisible to a lint rule reading
// import statements one file at a time. So the plugin below emits what Rollup
// actually linked and the check reads that.
//
// Two things the dev server does that the build does not.
//
// `/api` is proxied to the API's own port, so the browser makes same-origin
// requests and there is no CORS configuration standing between a person and
// the acceptance cases. The API's address is a variable, because the port is
// the API lane's to own.
//
// Every unknown path falls back to `index.html`. `/task/<key>` is a real
// address that a person reloads (checklist B5), and a dev server that 404s it
// would make the reload case untestable for a reason that has nothing to do
// with the product.
//
// One thing both do: stamp the build (S0-1, line C2). The identifier from
// `build-stamp.ts` is compiled into the bundle for the shell to draw, written
// into the entry document as a `<meta>`, and, in a build, written into the
// artefact as `build.json`. The dev server stamps its page too, with the
// checkout it started from, so a browser run can tell which build served it.

import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildIdentifier, STAMP_FILE, STAMP_META } from './build-stamp.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Every module Rollup put in the bundle, with what each one imported. */
function moduleGraphManifest(): Plugin {
  return {
    name: 'ops-astro-module-graph',
    generateBundle(_options, bundle) {
      const modules: Record<string, readonly string[]> = {};
      for (const id of this.getModuleIds()) {
        // Virtual modules and Vite's own helpers are not repository files and
        // are not what the rule is about.
        if (id.startsWith('\0') || !id.startsWith(root)) continue;
        const info = this.getModuleInfo(id);
        if (info === null) continue;
        modules[relative(id)] = info.importedIds
          .filter((imported) => imported.startsWith(root))
          .map(relative);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'module-graph.json',
        source: `${JSON.stringify({ root: '.', modules }, null, 2)}\n`,
      });
      // The entry chunks, so the check knows where to start walking rather than
      // assuming.
      const entries = Object.values(bundle)
        .filter((chunk) => chunk.type === 'chunk' && chunk.isEntry)
        .map((chunk) => chunk.fileName);
      this.emitFile({
        type: 'asset',
        fileName: 'entries.json',
        source: `${JSON.stringify(entries, null, 2)}\n`,
      });
    },
  };
}

/**
 * The version stamp, always read from the checkout being built: nothing in the
 * environment can name a build, so no artefact carries a version it was not
 * made from. `scripts/build.mjs` reads the artefact back and checks it.
 */
function buildStamp(): Plugin {
  const build = buildIdentifier(root);
  return {
    name: 'ops-astro-build-stamp',
    config: () => ({ define: { 'import.meta.env.VITE_OPS_ASTRO_BUILD': JSON.stringify(build) } }),
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { name: STAMP_META, content: build }, injectTo: 'head' },
    ],
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: STAMP_FILE,
        source: `${JSON.stringify({ build })}\n`,
      });
    },
  };
}

/** The dev server drops the content policy: fast refresh is an inline script. */
function devWithoutContentPolicy(): Plugin {
  return {
    name: 'ops-astro-dev-without-content-policy',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/u, ''),
  };
}

const relative = (id: string): string => id.slice(root.length).replace(/\?.*$/u, '');

const apiTarget = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:8790';
const port = Number(process.env['WEB_PORT'] ?? '5190');

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), moduleGraphManifest(), buildStamp(), devWithoutContentPolicy()],
  resolve: {
    alias: {
      '@launchastro/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    // The dev server serves any file under the workspace root through `/@fs/`,
    // which is how a source import reaches `packages/ui`. On 23 September a
    // probe of the running server got 200 and real content for
    // `/@fs/<worktree>/.local/db.env`, and the same for `.local/auth.env` and
    // `.local/synthetic-users.json`: the generated database password, the
    // GoTrue secret and every synthetic login, readable by anything that can
    // reach the port. Loopback-only binding is what kept that local rather
    // than remote; it is not a reason to serve them.
    //
    // Listing `deny` replaces Vite's default list, so the defaults are
    // repeated here rather than lost. Source imports are untouched: `.local/`
    // holds runtime scratch that nothing in `src` imports.
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/*.local'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Readable rather than minified: the module-graph manifest is the artefact
    // a person checks, and a build nobody can read is a build nobody audits.
    minify: false,
  },
});
