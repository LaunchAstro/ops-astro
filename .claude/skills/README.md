# Vendored skills

Two sets of skill files, committed like any other file, so every clone has
them and a change to a recipe is a pull request reviewed like code.

`AGENTS.md` is the law over both. It names the router, the in-scope list, the
exclusions, the one-owner table and the three rules this repository adds.

## What is here

| Set | Count | Licence file |
|---|---|---|
| Matt Pocock, the official group | 25 | `LICENSE-mattpocock-skills` |
| Pstack, hand-picked | 15 | `LICENSE-open-pstack` and two more |

`../../.codex/skills` is a symlink to this directory, so Codex reads the same
files as Claude Code. There is one copy, not two.

### The Pocock 25

Installed with `npx skills@latest add mattpocock/skills`, at project scope,
copied rather than symlinked. The official group is the upstream
`engineering` folder (18) and `productivity` folder (7). Nothing from
`in-progress` or `misc` is here, which is why `setup-pre-commit` is absent.

The installer writes no licence file, so the upstream MIT licence is copied
in by hand as `LICENSE-mattpocock-skills`. The upstream commit is recorded in
the commit message that added them and in `skills-lock.json`.

### The Pstack 15

Copied by hand from the `open-pstack` checkout, because the installed plugin
directory does not contain the licence files and a naive copy would leave
them behind. All three MIT licences from the marketplace root are here:

- `LICENSE-open-pstack`, Lauren Tan.
- `LICENSE-open-pstack-cursor-team-kit`, Cursor, for seven imported skills.
- `LICENSE-open-pstack-superpowers`, Jesse Vincent, for the hook runner.

Seven are callable tools: `unslop`, `show-me-your-work`,
`create-verification-skill`, `maintain-verification-skill`, `blast-radius`,
`technical-writing`, `typescript-best-practices`.

Eight are principle leaves, marked `user-invocable: false`. Nobody types
`/principle-prove-it-works`. Upstream they are read by a router this
repository does not use, so here they are reference, and their rules act only
by being quoted into `AGENTS.md` as standing rules.

Everything else in Pstack stays out by rule rather than by roster: the router
`poteto-mode` and its playbooks, `figure-it-out`, `arena`, `swarm`,
`interrogate`, `setup-pstack` (never run: it stands up a four-model panel,
which is spend), the personal explainers, and the remaining principle leaves.

## The `_shared` directory

`_shared/` is written by this repository, not vendored. It exists because the
vendored skills pointed at files that are not here.

- `codex-tools.md`, the neutral tool-name adapter. Upstream this reference
  lives inside `poteto-mode`, which is excluded as a second router, so two
  skills were linking to nothing.
- `security-review.md`, the same procedure `/security-review` runs, written
  so a runtime without that command can carry it out. `AGENTS.md` makes the
  review mandatory, and a rule only one runtime can obey is not a rule.
- `excluded-skills.txt`, the list `scripts/skill-refs-check.mjs` enforces.

`scripts/skill-refs-check.mjs` fails the build when a skill links to a file
that does not exist, or points at a name on the exclusion list. It runs in
`pnpm check` and in continuous integration.

## The local edits

Four, all deliberate, all listed here because **a re-copy from upstream
silently drops them**. This is the file a person reads before re-copying.

**Pstack, `principle-never-block-on-the-human`.** Upstream names its
boundaries as force-push, deleting production data and sending external
messages. The vendored copy adds a **spend** boundary.

**Pstack, `create-verification-skill` and `maintain-verification-skill`.**
Both linked to `../poteto-mode/references/codex-tools.md`. That router is
excluded, so the link resolved to nothing. Both now point at
`_shared/codex-tools.md`.

**Pstack, `blast-radius`.** It told the reader to use `how`, `why` and
`arena`, three skills excluded with the router. The instructions are rewritten
to say what to do instead: pull the pull request with `gh` and `git`, and get
the second opinion from a frontier model at a different company, which is the
adversarial pass `AGENTS.md` already requires.

**Pocock, `implement`.** Upstream runs `/code-review` before committing. In
this repository that reviews a tree that does not contain the work, because
`/code-review` diffs commits. The vendored copy adds a "Checkpoint before
review" section that commits the ticket first, records the base and head with
`scripts/review-preflight.mjs`, and treats a post-review fix as a new head
that invalidates the earlier review. The reasoning and the rehearsal are in
`docs/agents/review-checkpoint.md`.

## Refreshing

Two rules, because the two sets arrive differently.

**Pocock.** Re-run the installer against a named upstream commit. Review the
diff like a dependency bump. Keep `LICENSE-mattpocock-skills`. Record the new
commit in the commit message.

**Pstack.** Re-copy from the checkout at a named version. Then re-apply the
spend-boundary edit above. Then check the three licence files are still here.
Record the version in the commit message.

Either way: the skills are vendored, so a refresh is a reviewed change, not
an update that happens to you.
