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
// set where the API is started.
//
// Every unknown path falls back to `index.html`. `/task/<key>` is a real
// address that a person reloads (checklist B5), and a dev server that 404s it
// would make the reload case untestable for a reason that has nothing to do
// with the product.

import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { isLoopback, readIdentity } from '../api/identity.ts';

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
          .map((target) => relative(target));
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
 * The dev server's own identity, read on every request because Vite serves an
 * edit without a restart (T2b, spike RN-03). `/api/identity` beside it is the
 * API's, through the proxy, so a check compares the two process ids. Loopback
 * only, as the API's route is.
 */
function servedIdentity(): Plugin {
  return {
    name: 'ops-astro-served-identity',
    configureServer(server) {
      server.middlewares.use('/__identity', (request, response) => {
        if (!isLoopback(request.socket.remoteAddress)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(readIdentity(root)));
      });
    },
  };
}

const relative = (id: string): string => id.slice(root.length).replace(/\?.*$/u, '');

const apiTarget = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:8790';
const port = Number(process.env['WEB_PORT'] ?? '5190');

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The interface's asset licence record and licence texts ship beside the
  // fonts and icons they cover (MP-1-2), at `/licences.json` and `/licences/`.
  publicDir: fileURLToPath(new URL('../../packages/ui/assets', import.meta.url)),
  plugins: [react(), moduleGraphManifest(), servedIdentity()],
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
    // which is how a source import reaches `packages/ui`. Without a deny list
    // that includes `/@fs/<worktree>/.local/db.env`, `.local/auth.env` and
    // `.local/synthetic-users.json`: the generated database password, the
    // GoTrue secret and every synthetic login, readable by anything that can
    // reach the port. Loopback-only binding keeps that local rather than
    // remote; it is not a reason to serve them.
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
