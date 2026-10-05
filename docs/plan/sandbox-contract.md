# Sandbox launcher contract (draft, not approved)

Status: **draft for approval**. Drafted 5 October 2026 under
[ADR 0048](../adr/0048-sandbox-launcher-contract-drafted-reviewed-not-built.md),
revised the same day after four adversarial reviews. Nothing here is built.
Nathan approves the final version after the adversarial findings are
resolved, and only then may implementation start. Until then untrusted
package installation and headless execution stay unavailable, with no
unsandboxed fallback.

Each numbered line is a rule the implementation must keep and a test must
prove (section 13). A line that cannot be proven is a refusal, not a warning.
Every grammar here is closed: what it does not name is refused.

Terms, each used in one sense only:

- **site record**: Ops Astro's record of one client site (section 3, I6);
- **pin**: the site record's toolchain entry in `docs/supply-chain-pins.md`
  (lockfile digest, base and entrypoint digests per platform, image id);
- **pin list**: the file the socket proxy reads the pinned image ids from,
  written only by the deploy of a reviewed change;
- **image store**: the Docker daemon's images;
- **package registry**: an npm registry;
- **tool registry**: Ops Astro's list of tools and their availability.

## 1. Scope, first user and trust

The launcher runs code we do not trust in a container and hands back only
bytes. Its first user is the site change envelope (issue #972): to decide
whether an automated edit to a client's live Astro site is one word of body
copy, the envelope builds the site before and after the edit with the site's
pinned toolchain and compares the two outputs.

Building a site runs the site's code: its `astro.config.mjs`, integrations
(for the template site `@astrojs/sitemap`, `@astrojs/mdx`,
`@astrojs/partytown`, `astro-icon`, `astro-compress`), Vite plugins such as
`@tailwindcss/vite`, and native modules such as `sharp`.

- **T1. Containment** treats all of that code as hostile.
- **T2. The verdict** trusts the pinned toolchain's output as a model of the
  host's build, and nothing more. Hostile code inside a run can always write
  any output it likes, so the toolchain must be one a person approved: a pin
  changes only through a reviewed change, and the launcher never writes one.
  The verdict also trusts the site's own code at `baseRevision` (its config,
  integrations and components), which no pin covers, only as much as it is
  already trusted by being live.
- **T3.** Agent tools that run arbitrary code, headless browsers and any other
  user are out of scope. Each needs its own amendment and its own approval.

## 2. Run classes

The launcher knows exactly three run classes. Any other request is refused.

- **S0. `probe`**: our fixed probe image by digest and its fixed command,
  with the create body of the class it probes (section 8, appendix).
- **S1. `site.build`**: build one site tree with its pinned image. The
  container command is fixed: the launcher's entrypoint (its own pinned
  layer, B8) first checks that its environment is exactly B3 and exits
  refused if not, then reads the input tar from stdin into `/work`, runs the
  site record's build command with its stdout sent to stderr, and writes a
  tar of `dist/` to the original stdout. No site code runs before that
  check. Used twice per envelope check.
- **S2. `site.prepare`**: install one site's dependencies, offline, into the
  layer its image is assembled from (B8). Runs only on the request of a
  reviewed pin change (T2), never during a check. It receives only
  `package.json`, `package-lock.json`, the package tarballs (E2) and an npm
  configuration the launcher writes; never the site tree or any
  configuration file from it. Anything given to it is treated as public. It
  runs in the base-plus-entrypoint image (no `node_modules` layer), whose id
  is pinned per platform.

No run class has network access (section 5).

## 3. Accepted and refused inputs

The launcher reads every request as a JSON body parsed with a real parser,
with an exact key set per run class and each value checked against an
allow-list. Unknown keys, unknown values and extra fields are refused.

- **I1. `site.build` accepts only:** a site id with a site record and a pin; a
  `baseRevision` (40 hex characters); and one changed file: its path and its
  new content (at most 64 KiB of UTF-8). The path must exist at
  `baseRevision` as a regular file and must match the site record's content
  allow-list: `src/pages/`, `src/content/` or `src/components/`, extension
  `.astro`, `.md` or `.mdx`. A path that any package manager, Astro, Vite,
  git, CI or the host reads as configuration is never on that list.
- **I2. The launcher assembles the input tree itself**, in memory, from the
  site repository's git objects at `baseRevision`, through the credential
  broker's read operation. It reads tree objects, never an archive endpoint;
  a truncated listing is a refusal; each blob's bytes must hash to its git
  object id. The credential never enters a sandbox; only bytes do.
- **I3. The tree is refused** when it holds:
  - more than 20,000 entries or 50 MB;
  - any entry other than a regular file or a directory (no symlink, no
    submodule);
  - a name outside O1's character set plus `[` and `]` (for dynamic routes
    such as `[slug].astro`), a name that is not NFC, or two names equal
    after ASCII case folding;
  - an entry named `node_modules`, `dist`, `.astro`, `.vercel` or `.netlify`
    at any depth;
  - a `.gitattributes`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`,
    `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
    `pnpm-workspace.yaml` or `.pnpmfile.cjs` anywhere.
- **I4. The pin is refused** unless the digest of `package.json` and
  `package-lock.json` together, in the tree as built, equals the pin's. Since
  I1 never accepts either file as the changed path, the before and after trees
  carry the same pair.
- **I5. The lockfile grammar.** `site.prepare` accepts only
  `package-lock.json` with `lockfileVersion` 3 and a `package.json` with no
  `packageManager` field. Every non-root package entry has a `sha512`
  `integrity` and a `resolved` URL of exactly one of two forms. `<name>` is
  the entry's key after its last `node_modules/` and follows npm's name
  grammar; `<version>` is the entry's own `version`; `<base>` is `<name>`
  without its scope. An entry carrying a `name` field (an alias) is refused.
  - `https://registry.npmjs.org/<name>/-/<base>-<version>.tgz`;
  - `https://npm.pkg.github.com/download/<name>/<version>/<40 hex>`, with
    `<name>` under a scope the site record lists.

  Any other form, a `link` entry, a missing or weaker integrity, or any other
  host is a refusal.

- **I6. The site record** holds the build command, the host's install
  command, the output directory (`dist`), the Node version, the build
  environment variables and their values, `build.format`, `trailingSlash`,
  `output`, the private package scopes and the content allow-list. It equals
  the host's production build (H1) and changes only through a reviewed
  change. No build variable whose value is a secret is ever recorded; a site
  whose host build needs one is refused.

## 4. Isolation

Every run is one new container under gVisor (`runsc`), removed when the run
ends, whatever the outcome.

- **B1. Runtime.** `runsc` at the version and hash pinned in
  `docs/supply-chain-pins.md`, installed at a path that contains its sha256
  (`/opt/runsc/<sha256>/runsc`) on a read-only filesystem, which a VM boot
  check hashes before the daemon starts. It is registered with the daemon by
  that path and a pinned argument list: `--network=sandbox`, no host Unix socket or
  FIFO access, no flag override, no host-backed overlay, no debug log, and a
  named platform. Before every run the launcher reads the runtime entry
  through `GET /info` and refuses when the path or arguments differ from the
  pin.
- **B2. Network.** Network mode `none` for every run class: loopback only.
- **B3. Environment**, exact per class, including what Docker and the base
  image add:
  - S1: `PATH`, `HOME=/tmp/home`, `HOSTNAME=sandbox`, `NODE_ENV=production`,
    `ASTRO_TELEMETRY_DISABLED=1`, the base image's own variables with the
    values its pinned config gives (written out in the pin), and the site
    record's build environment variables with the values the record gives;
  - S2: the same without `NODE_ENV`, and with a npm user configuration the
    launcher writes (offline, `ignore-scripts`, cache path);
  - S0: as the class it probes.
  - No env file, no mounted credential, no Docker socket.
- **B4. Host writes.** A read-only root filesystem; no bind mount, `Mounts`
  entry or volume, named or anonymous; the assembled image declares no
  `VOLUME`. The only writable places are `tmpfs` mounts at fixed paths
  (`/work`, `/tmp`) with `nosuid,nodev` and a size inside the memory limit,
  and Docker's `/dev/shm` at the appendix's fixed `ShmSize`. The mounts
  Docker inserts (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`) are
  read-only. The log driver is `none`: output leaves only through attach.
  Vite's and Astro's caches land in `/work/node_modules/` (tmpfs), because
  the installed packages sit at `/node_modules` (B8).
- **B5. Privileges.** A fixed non-root uid and gid, every capability dropped,
  `no-new-privileges`, no devices, no host namespace (pid, ipc, uts,
  network, user, cgroup).
- **B6. Caps per run:**

  | Class | Wall            | Memory (no swap) | CPU | Processes | Input  | Output | stderr kept |
  | ----- | --------------- | ---------------- | --- | --------- | ------ | ------ | ----------- |
  | S1    | 120 s           | 1 GiB            | 1   | 256       | 50 MB  | 50 MB  | 64 KiB      |
  | S2    | 600 s           | 4 GiB            | 1   | 256       | 600 MB | 1 GB   | 64 KiB      |
  | S0    | as probed class | as probed class  | 1   | 256       | 1 MB   | 1 MB   | 64 KiB      |

  The socket proxy enforces the wall clock from its own durable record, not
  only the launcher (P6).

- **B7. Machine share.** One sandbox at a time, a queue of at most four and a
  queue wait of at most 300 s. Every sandbox runs with `OomScoreAdj` 1000.
- **B8. Images.** No image is built by the daemon. The launcher assembles each
  site image itself as an image archive, bottom to top:
  - the Node base image's pinned layers in their pinned order, and its
    config, from an archive that arrives through the reviewed pin change and
    is checked against its pinned per-platform digests at every assembly;
  - one `node_modules` layer, unpacked at `/node_modules` only, which the
    launcher writes from S2's output under O2's rules;
  - the launcher's entrypoint layer (pinned) on top, so nothing below can
    shadow it.

  The assembled config sets no `Entrypoint`, `Cmd`, `Volumes`,
  `Healthcheck`, `OnBuild` or `StopSignal` of its own. The VM's daemon uses
  the classic overlay2 image store, and the image id is the sha256 of the
  image config, which the launcher computes. Making a pin: for a site whose
  lockfile digest is pinned, S2, the assembly and F2 run on the production
  sandbox VM through the proxy; the proxy loads that not-yet-pinned image
  for F2 runs only, records the id it computed itself, and refuses that id
  to every check. The reviewed second commit copies the proxy's recorded id
  into the pin; the launcher never writes it. The load (P5) must report the
  same id. Site images are removed when their pin is replaced, and at most
  50 are kept.

- **B9. Placement.** Sandboxes run in a dedicated Linux VM on the production
  machine that runs no live service, shares no host folder, holds no
  credential, and has its own Docker daemon with automatic updates off.
  - The daemon listens on no TCP port. Its socket reaches the machine only
    as one path readable by the proxy's own uid alone (mode 0600), never
    mounted into the launcher or any other unit. The proxy runs as a uid no
    other process on the machine uses.
  - While in production use the VM exposes no ssh, shell or other
    management path.
  - The daemon's default runtime is `runsc`, and its `daemon.json` is pinned
    by hash and checked at VM boot.
  - The VM has no network interface beyond the channel that carries the
    daemon socket to the proxy, or one whose filter sits outside the VM (the
    VM tool's network filter or the machine's packet filter), which nothing
    inside the VM can change.

  A placement beside live services needs its own amendment and approval.

## 5. Egress

- **E1.** No run class has network access (B2). There is no egress relay and
  no network for sandboxes.
- **E2.** Package tarballs reach `site.prepare` without network. The
  credential broker's fetch operation, never the launcher, fetches each
  lockfile entry's `resolved` URL (I5) from its fixed host. For
  `npm.pkg.github.com` it fetches only names under the site record's
  scopes, follows a redirect only to a fixed list of hosts, and never sends
  the credential on a redirect. The launcher checks each tarball's `sha512`
  and hands the tarballs in on stdin as an npm cache. It never unpacks one,
  and it keeps question 2's single internal network and no other. S2 runs
  `npm ci --offline --ignore-scripts --include=dev`, so no lifecycle script
  runs.
- **E3.** A site that needs a lifecycle script to build is refused.
  (`npm ci --ignore-scripts` is already the site engine's install rule, and
  the template site builds that way, sharp included.)

## 6. Socket-proxy operations

The launcher never holds the Docker socket. It talks to a socket proxy of
ours over a Unix socket that only the launcher can reach. The proxy reads each
request as a closed grammar and forwards only what it re-serialises from the
checked values, never the bytes it received.

- **P1. Request form.** A fixed API version prefix (`/v1.NN/`); the path
  rebuilt from the matched pattern; the query rebuilt from the named
  parameters; the body rebuilt from the checked value. Refused: any other
  version or none, percent-encoding or dot segments in the path, a query
  parameter not named below, duplicate JSON keys at any depth, a key that
  differs only in case, `Transfer-Encoding`, any header other than `Host`,
  `Content-Type`, `Content-Length` and (on attach) `Connection` and
  `Upgrade`, a body on an operation named without one, and a second request
  on one connection (except the attach stream).
- **P2. Health.** `GET /_ping`, `GET /version` and `GET /info`, no query.
- **P3. Create.** `POST /containers/create` with no query, and a body
  structurally equal to its class's fixed body in the appendix, with exactly
  one slot filled: `Image`, which must be `sha256:` plus 64 hex characters
  and name an image the pin list holds for that class. Before each create,
  `GET /info` must report a container count equal to the proxy's record, or
  the launcher is unavailable. Any other difference,
  a missing key, or a key added with the daemon's default value, is a
  refusal.
- **P4. Run.** For a container whose full 64-hex id the proxy recorded
  durably from its own create, and nothing else (names and prefixes are
  refused):
  - `POST /containers/{id}/attach` with exactly
    `stream=1&stdin=1&stdout=1&stderr=1`, before start;
  - `POST /containers/{id}/start`, `POST /containers/{id}/wait` and
    `POST /containers/{id}/kill`, each with no query and no body (kill is
    SIGKILL);
  - `GET /containers/{id}/json`, no query, of which only `State.OOMKilled`
    is read;
  - `DELETE /containers/{id}?force=1`.
- **P5. Images.** `POST /images/load?quiet=1` only after the proxy has parsed
  the archive itself and rebuilt it with exactly `manifest.json`, the config
  blob and the layer files (a `repositories`, `index.json`, `oci-layout` or
  any other member is refused): its manifest names exactly B8's layers in
  order; the base and entrypoint layers equal their pinned digests byte for
  byte; the `node_modules` layer passes O2's grammar, re-checked by the
  proxy; there are no `RepoTags`; and the image id the proxy computes is in
  the pin list, or is a pin being made (B8). `GET /images/{id}/json` and
  `DELETE /images/{id}` (no query) for site images in the pin list or
  removed from it by the last deploy, never the base image.
- **P6. Deadline and sweep.** The proxy kills any recorded container past its
  class's wall clock, measured in wall-clock time from the recorded start,
  whatever the launcher does. On start, before it takes a
  request, it kills and removes every container in its record, and it refuses
  a create while any recorded container still exists.
- **P7.** Everything else is refused: `/build`, `/session`, exec, commit,
  archive copy in or out, image pull, push or export, plugins, networks,
  volumes, swarm, events, system prune.

## 7. Output and host fidelity

Output is untrusted bytes, read as a closed grammar in memory and never
extracted to disk.

- **O1. `site.build` output** is one ustar stream:
  - type `0` (file) or `5` (directory) only; no PAX (`x`, `g`), GNU (`L`,
    `K`, `S`) or any other type;
  - magic `ustar\0` and version `00`; name plus prefix at most 255 bytes;
    octal size fields only, and 0 for a directory; every header checksum
    verified; exactly two zero blocks at the end and no byte after them;
  - every file's parent directory has its own earlier entry;
  - every name canonical (no leading `./`, no empty or `.` or `..` segment,
    no trailing `/` on a file), matching `^dist(/[A-Za-z0-9._~@+-]+)*$`, NFC,
    and unique after ASCII case folding;
  - at most 5,000 entries; the size cap counted on stream bytes;
  - mode, owner and time fields ignored.
- **O2. `site.prepare` output** follows O1 with root `node_modules`, up to
  200,000 entries and 1 GB. A symlink (type `2`) is accepted only when its
  link name is at most 100 bytes, relative, and, resolved against its
  parent's real path (after every earlier symlink), stays inside
  `node_modules/`; an entry whose path passes through a symlink entry is a
  refusal. A name segment beginning `.wh.` is refused. The launcher writes
  the image layer anew from the accepted entries: a file is 0755 when its
  header's owner-execute bit is set and 0644 otherwise, directories 0755,
  owner 0:0, a fixed time, no extended attributes.
- **O3. Exit.** Success needs exit code 0 within every B6 cap, with
  `State.OOMKilled` false. R1 reports `memory` only when `OOMKilled` is true;
  any other failure to finish is `non-zero exit` or `deadline`. stderr is kept for a person and never read into a
  decision.
- **O4. Comparison**, for the envelope:
  - the two outputs carry exactly the same set of names;
  - the target file is `dist/` plus the catalogued page address mapped by the
    site record's `build.format` and `trailingSlash` (a site whose
    `build.format` is `preserve` is refused); it exists in both and differs;
  - every other name's content bytes are equal;
  - the target's two versions then go to the envelope's token grammar.

  O4 passing is necessary, not sufficient: the envelope's static layers must
  pass too (D2).

- **O5. Binding.** A verdict covers exactly (site, the site record's digest,
  `baseRevision`, path, sha256 of the new content, image id). The publish
  lands only as a fast-forward-only update of the branch, from exactly
  `baseRevision`, to a commit whose only parent is `baseRevision` and whose
  tree differs from it only at the path, whose blob is the new content. The
  publish flow and the client branch protection change to allow this
  (section 12, question 6). A
  merge, a squash or an update from any other head is refused, and the
  verdict lapses. Anything else is a new check, never a reuse.
- **H1. Host fidelity.** "Served" in O4 means built by the pinned toolchain
  under B3. The verdict carries over to the host only where the two match, so
  a site is refused when:
  - its record's build command, install command, Node version or build
    variables differ from the host's configured production build, or the
    host's install is not `npm ci --ignore-scripts` with the base image's
    npm. The sandbox-only variables and layout in B3 and B8 are accepted
    differences, and host-injected variables are listed per host under
    question 4;
  - its `output` is not `static`, it uses an adapter, or any page uses
    `server:defer`;
  - the host rewrites HTML after the build (section 12, question 4);
  - its build tried to reach the network when the pin was made: F2's builds
    run on the production sandbox VM through the proxy as S1 runs, with
    runsc's trace points in B1's pinned argument list recording every
    non-loopback connect or send and every name lookup to a sink on the VM,
    and any record refuses the pin. No client site is built in CI, which
    runs only our fixtures. Template dependencies that fetch at build time, such as
    the astro-embed components, make a site refused, never a reason to give
    `site.build` network.

  At check time a build has no network, so a fetch fails or falls back. The
  residual, a fetch path that only the edited word reaches, is accepted only
  because the word is letters only and sits in a text node, as the
  envelope's static layer checks (D2); the launcher's verdict is never used
  without it.

## 8. Preflight

- **F1. Probe.** At start and after any F3 difference, the launcher runs S0
  once per run class with that class's create body (the appendix gives the
  differences). Every 15 minutes it probes S1 only, without the wall-clock
  crossing; S2's probe also runs before each S2 run. From inside it proves each limit by
  crossing it:
  - the kernel is gVisor's, and the only interface is loopback;
  - no address answers: a public address, the metadata address, the VM's and
    the machine's addresses, Docker's host gateway, the LAN, the proxy, and
    IPv6;
  - the root filesystem refuses a write, the complete writable set is
    `/work`, `/tmp` and `/dev/shm`, and each fills to ENOSPC at its size;
  - the environment is exactly B3, and effective capabilities are zero;
  - allocating past the memory limit ends the run for memory, a fork past
    256 is refused, and outliving the wall clock ends in the kill;
  - writing past the output cap gives the refusal;
  - and, run by the VM's boot check and by a machine-side check at deploy and
    after any F3 difference (never by the launcher, and F3 reads their last
    result): from the VM, the machine, the LAN and a public address do not
    answer; on the machine, neither the launcher's uid nor the machine's main
    user can open the daemon socket.
- **F2. Reproducibility**, a precondition for recording a pin, not a safety
  control (every check re-proves equality under O4): three builds of the
  unchanged tree, compared as O4 compares, must be identical. It is repeated
  whenever the base, the entrypoint layer or the lockfile changes.
- **F3. Drift.** Before every run, `GET /version` and `GET /info` (engine,
  kernel, runtimes with their hash-bearing paths and arguments, image store)
  must equal those at the last passed probe. Any difference, or a failed probe, marks the launcher
  unavailable until a new probe passes.

## 9. Failure

- **R1.** Every failure is a refusal with a named reason: unavailable,
  preflight failed, drift, unknown site, no pin, pin mismatch, input refused,
  lockfile refused, fetch failed, integrity mismatch, image load failed,
  proxy refused, queue full, deadline, memory, process limit, output refused,
  non-zero exit, network attempted, host fidelity. Any other failure is the
  refusal `internal`, and a caller that gets no well-formed answer treats it
  as `unavailable`.
- **R2.** No retry inside a check. Every container is removed in every case,
  including after a launcher, proxy or daemon restart (P6).
- **R3.** For the envelope, a refusal is `CHANGE_ENVELOPE_EXCEEDED` with that
  reason, so the edit goes to a person.

## 10. Degraded behaviour

- **D1.** The tool registry reports availability per run class with the
  reason. Agent tools that run arbitrary code and headless execution stay
  `unavailable` whatever the launcher's state (T3).
- **D2.** There is no fallback: no build outside gVisor, no output built
  anywhere else (CI artefacts, host previews) standing in, and the envelope's
  static checks alone never approve an automatic publish.

## 11. Where it runs

| Place                            | Runs                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Production machine, sandbox VM   | The socket proxy's daemon and the sandboxes (B9)                                        |
| Production machine, outside it   | The launcher and the socket proxy, as their own unit (question 2)                       |
| CI (existing GitHub-hosted runs) | `runsc` installed in the job; the section 13 suite on our fixtures; never a client site |
| A developer's macOS laptop       | Nothing sandboxed; the grammar corpus only; sandbox tests report absent                 |

The launcher reports a run class available only after the full section 13
suite has passed on the production sandbox VM, and again after any F3
difference. No paid service and no new hosted runner.

Expected refusals, safe but frequent: sites over the size caps, sites with
build-time fetches, and every site whose lockfile changed until its new pin
is reviewed.

## 12. Open questions for approval

1. **The sandbox VM (B9).** The production machine is an arm64 Mac. Which free
   VM tool hosts the sandbox VM, and whether gVisor's platform runs there
   (systrap, or KVM if nested virtualisation is available), is unverified. If
   neither works, the launcher stays unavailable.
2. **The launcher's unit.** Staging's rule is that no service mounts a path
   from the machine. The proxy needs the sandbox VM's Docker socket and the
   launcher needs the proxy's. This contract keeps both as their own unit:
   the proxy on a Unix socket only, on no network; the launcher on one
   internal network shared with the production worker and nothing else,
   with a read-only root, no secrets, every capability dropped and limits
   sized for a 1 GB output. Staging gets its own launcher or none. It asks
   for that exception by name.
3. **The site engine's settled rules.** The site-engine specification says
   Ops Astro never calls a site-side command and never builds a site, so it
   needs no package token (SPEC 5.7 and section 10, item 6). This contract's
   first user builds the site, and `site.prepare` fetches private packages
   with that token through the credential broker. Approving this contract
   amends those two rules; refusing it keeps them and leaves #972 without a
   build.
4. **The host.** Which host serves client sites and whether it rewrites HTML
   after the build (H1) is not recorded. Until it is, every site fails H1 and
   is refused.
5. **Unverified mechanisms.** Whether runsc's trace points can feed a sink on
   the sandbox VM (H1), whether GitHub Packages downloads redirect and to which hosts
   (E2), and how runsc backs `/dev/shm`. Each is settled by a crossing test
   before the line that needs it may pass; until then that line refuses.
6. **The publish flow.** O5 lands an approved edit as a fast-forward of the
   client's branch, not through a merged request. That changes
   `publish.ts`'s flow and each client repository's branch protection, and
   is part of what this approval amends.

## 13. Proof before merge of the implementation

Every numbered line is in exactly one of these two lists:

- Crossings, in a real `runsc` container or VM: T1, B1-B9, E1-E3, P6, F1,
  F2, H1. A real network attempt, a real write, a real secret
  probe, a real cap, a real load.
- Corpus fixtures, one per refusal clause: T2's pin rule, T3, S0-S2, I1-I6,
  P1-P5, P7, O1-O5, F3, R1-R3, D1-D2.
- Each test fails with its guarding clause removed, and the pull request
  lists that red under "Undo-red".
- The suite runs in CI against our fixtures and on the production sandbox VM
  (section 11).

## Appendix: the fixed create body

The proxy holds this body for `site.build` and compares each request with it
whole (P3). The other bodies differ from it in these keys only, with these
values, and in nothing else:

- `site.prepare`: `Cmd` `["prepare"]`; `Env` the S2 list from B3;
  `Memory` and `MemorySwap` 4294967296; `Tmpfs` `/work` size 2147483648 and
  `/tmp` size 1073741824.
- `probe`: `Image` the pinned probe image; `Cmd` `["probe", "<class>"]`;
  for S1, `Env` the fixed variables of B3 and no site variables; every other
  key as the probed class's body.

```json
{
  "Image": "<slot: sha256 id>",
  "Entrypoint": ["/opt/launcher/entrypoint"],
  "Cmd": ["build"],
  "User": "10001:10001",
  "WorkingDir": "/work",
  "Hostname": "sandbox",
  "Env": ["<the S1 list from B3, fixed per pin>"],
  "AttachStdin": true,
  "AttachStdout": true,
  "AttachStderr": true,
  "OpenStdin": true,
  "StdinOnce": true,
  "Tty": false,
  "NetworkDisabled": true,
  "Healthcheck": { "Test": ["NONE"] },
  "Volumes": {},
  "Labels": {},
  "HostConfig": {
    "Runtime": "runsc",
    "NetworkMode": "none",
    "ReadonlyRootfs": true,
    "CapDrop": ["ALL"],
    "SecurityOpt": ["no-new-privileges"],
    "Privileged": false,
    "Memory": 1073741824,
    "MemorySwap": 1073741824,
    "NanoCpus": 1000000000,
    "PidsLimit": 256,
    "OomScoreAdj": 1000,
    "ShmSize": 16777216,
    "Tmpfs": {
      "/work": "rw,nosuid,nodev,size=402653184",
      "/tmp": "rw,nosuid,nodev,size=268435456"
    },
    "LogConfig": { "Type": "none", "Config": {} },
    "RestartPolicy": { "Name": "no" },
    "AutoRemove": false,
    "Init": false
  }
}
```
