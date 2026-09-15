# The contamination gate

This foundation is intended for public release. The gate checks for known
private-content patterns before publication. It reduces accidental disclosure;
its limits are listed below.

## What it reads, and when

The scan target changes with the operation. A clean working tree does not
establish that the index or outgoing history is clean.

| When        | What is read                                                        | Why that and not something else                                                                                      |
| ----------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pre-commit  | The **staged blobs**, out of the index                              | Stage bad content, clean the working copy without staging the cleanup, and a working-tree scanner reports clean      |
| Pre-push    | **Every blob in every outgoing commit**, both sides of every change | A file added and later deleted still sits in history, and once pushed it is public for good                          |
| `pnpm gate` | Every tracked file in the working tree                              | The cheap continuous check. Not sufficient alone, which is why the two above exist                                   |
| CI          | The outgoing range on a pull request, and the tracked tree          | Public continuous integration runs after a push, so it cannot undo a disclosure. It is the backstop, never the guard |

These rules apply to all four:

- **Path rules run first, on every path, with no exclusions.** A directory the
  content scan skips must never become a place to hide a denied path.
- **There is no path the gate declines to read.** `git add -f node_modules/x`
  was a way past the content scan; a file only reaches the index because
  somebody put it there. Directory skipping belongs to filesystem walking, in
  `--path` mode, and nowhere else.
- **Exemptions are of bytes, not names.** Four files exist to contain what the
  gate looks for. Exempting them by path exempted whatever anyone later put
  in them, so `scripts/gate/approved-exemptions.sha256` holds the sha256 of
  every approved version of each, and anything else at those paths is scanned
  like any other file. Changing a fixture is two deliberate edits.
- **A merge is compared against each parent.** `git diff-tree` prints nothing
  for a merge commit unless asked, so a value invented while resolving a
  conflict appeared in no diff and sailed into the history.
- **It fails closed.** Anything the gate cannot read as UTF-8 text is a
  violation until someone writes that path into `binary-allowlist.txt` on
  purpose. A scanner that skips what it cannot parse is not a scanner.

## Two layers, on purpose

**The committed layer is blind.** `denylist.sha256` holds SHA-256 hashes and
never the terms. It runs in public continuous integration, where publishing
the terms would defeat the entire exercise. Hashes are unsalted so the check
can run anywhere.

Be honest about what the six character minimum buys. It is **not** a guarantee
of confidentiality: anyone can hash candidate names and compare them against a
published list. It raises the cost of a dictionary run and nothing more. The
list holds only invented canaries today, so the question is still avoidable;
when real terms are added, that is the moment to weigh salting the list
against being able to check it in public.

**The shape rules ship in the clear**, in `shape-rules.txt`, because a shape
names no identifier. They catch the class a hashed list cannot: a hashed list
finds only what somebody thought to add, and the contamination audit of the
other codebase found a real-looking contact card that no term on any list
covered. Categories are `pii`, `provenance` and `infra`.

**The maintainer layer is literal.** A maintainer may supply an external
clear-text list through `HUB_GATE_TERMS`. Keep it outside the repository.
It drives `--literal` at pre-push. When the file is absent the script says so and exits 2. It never pretends to have run.

Neither layer is sufficient alone. Together with gitleaks over the full
history, and with the rule that no material is ever copied across by hand,
they are the belt and the braces.

## The modes

| Command                                    | What it does                                                  |
| ------------------------------------------ | ------------------------------------------------------------- |
| `pnpm gate:selftest`                       | Proves the gate still works. Runs first, always               |
| `pnpm gate:cases`                          | Runs the regression cases against throwaway repositories      |
| `pnpm gate`                                | Sweeps every tracked file                                     |
| `pnpm gate:range`                          | Sweeps every blob in every outgoing commit. The pre-push hook |
| `python3 scripts/gate/sweep.py --staged`   | Sweeps the staged blobs. The pre-commit hook                  |
| `python3 scripts/gate/sweep.py --path DIR` | Sweeps anything on disk, inside the repository or out         |
| `pnpm gate:literal`                        | The maintainer clear-text sweep. Exits 2 with no list         |

Exit codes: 0 clean, 1 contamination found, 2 the clear-text list is absent,
3 the gate is broken or the arguments are wrong. A bad argument is 3, not
argparse's usual 2, so a hook can never read a typo as a missing list.

**Evidence is sanitised.** A finding prints its category, its path and a short
fingerprint, never the matched text, because this output lands in continuous
integration logs and agent transcripts. `--reveal` prints the text and is for
a local terminal only.

## The self-test comes first

A blind gate that has quietly stopped working looks exactly like a clean
repository. So the self-test runs before the sweep, every time, in the hook
and in continuous integration. If it fails, the run fails and no sweep result
is to be believed.

It makes three assertions:

1. The canary is flagged, and the widest phrase it matches is at least four
   words, so a four word entry on the denylist cannot silently never match.
2. Every shape rule fires against `tests/gate/shape-canary.txt`.
3. A missing private list exits 2, never 0.

Both fixtures are synthetic. `tests/gate/canary.txt` holds an invented
business name; `tests/gate/shape-canary.txt` holds one made-up example of each
shape. Neither is ever a real value.

`pnpm gate:cases` goes further and builds throwaway repositories to prove the
gate against the cases it once missed: a staged blob that differs from the
working tree, a file added and then deleted, a denied path inside an excluded
directory, unreadable content, a four word phrase, and the shape rules firing
outside their fixture.

## Adding a term

On a maintainer machine, with the clear-text list open:

```sh
printf '%s' "the term" \
  | tr '[:upper:]' '[:lower:]' \
  | tr -c 'a-z0-9' ' ' \
  | tr -s ' ' \
  | sed 's/^ //; s/ $//' \
  | shasum -a 256
```

Put the hash in `denylist.sha256`, the clear text in the private list, and
never the other way round. Terms shorter than six characters go in the private
list only.

Phrases of up to six words match, so a multi-word business name can go on the
list whole. The first version capped phrases at three words, which meant a
four word entry could never match and the list quietly lied about its own
coverage. `pnpm gate:selftest` now fails if the widest matching phrase drops
below four words.

A new shape rule goes in `shape-rules.txt` as `category|regex|description`,
with one synthetic example added to `tests/gate/shape-canary.txt`. The
self-test fails if any rule has no example that fires.

## What it cannot do

- It cannot catch a term nobody thought to add, unless it has a shape.
- It cannot catch a paraphrase, a screenshot or a re-typed value.
- It cannot read a binary file. It fails on one instead of skipping it, which
  turns a blind spot into a decision somebody has to make in writing.
- It cannot undo a push. Continuous integration runs after publication, so the
  pre-push hook is the guard and CI is only the backstop.

So it is a net under a rule, not the rule itself. The rule is that no client
material is copied into this repository, ever, by anyone, for any reason.
