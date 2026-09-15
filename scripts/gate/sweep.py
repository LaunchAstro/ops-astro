#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""The contamination gate.

Stops client material from ever entering this repository's history.

What it inspects, and why each mode exists
------------------------------------------

- **Before a commit**, it reads the *staged blobs* out of the index, not the
  working tree. Reading the working tree was the defect the sweep of
  6 September found: stage bad content, clean the working copy without
  staging the cleanup, and a working-tree scanner reports clean.
- **Before a push**, it reads *every blob in every outgoing commit*, on both
  sides of every change, so a file added and later deleted is still caught.
  A working-tree scan can never see that, and once it is pushed it is public
  for good.
- **Path rules run first, on every path, with no exclusions.** A directory
  the content scan skips must not become a place to hide a denied path.
- **It fails closed.** Anything it cannot read as text is a violation until
  someone writes that path into the binary allowlist on purpose.

The committed half is blind: it holds SHA-256 hashes of terms, never terms.
That is what lets it run in public continuous integration. Shape rules ship
in the clear because they name a shape and never an identifier, and they
catch the class of thing a hashed list misses: a hashed list only finds what
somebody thought to add.

Evidence is sanitised by default. A match prints its category, its path and a
short fingerprint, never the matched text, because this output lands in
continuous integration logs and agent transcripts.

Exit codes
  0  clean
  1  contamination found
  2  the clear-text list is absent (literal mode only)
  3  the gate itself is broken, or the arguments are wrong

Modes
  (none)        sweep the tracked files in the working tree
  --self-test   prove the gate still works, before believing any sweep
  --staged      read the staged blobs, for the pre-commit hook
  --range ...   read every blob in an outgoing commit range, for pre-push
  --path PATH   sweep one file or directory, anywhere on disk
  --literal     the maintainer-only clear-text sweep
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

DENYLIST = HERE / "denylist.sha256"
PATH_DENYLIST = HERE / "path-denylist.txt"
SHAPE_RULES = HERE / "shape-rules.txt"
BINARY_ALLOWLIST = HERE / "binary-allowlist.txt"

CANARY_FILE = REPO / "tests" / "gate" / "canary.txt"
SHAPE_CANARY_FILE = REPO / "tests" / "gate" / "shape-canary.txt"

# The private clear-text list is supplied explicitly and never stored in git.
LITERAL_LIST_ENV = "HUB_GATE_TERMS"

# The shortest term the hashed list carries, with spaces removed. Shorter
# names are covered by the literal sweep instead.
#
# Note what this does not buy: the hashes are unsalted so public continuous
# integration can check them, and anyone can hash candidate names and compare.
# Six characters raises the cost of a dictionary run. It is not a guarantee of
# confidentiality, and scripts/gate/README.md says so.
MIN_TERM_LENGTH = 6

# The longest phrase assembled out of neighbouring words. The first version
# capped this at three, so four word entries on the denylist could never
# match. Raising it costs a little time and closes that hole.
MAX_NGRAM_WORDS = 6

# Content exclusions are of **bytes, not paths**.
#
# Four files exist to contain the thing the gate looks for. Exempting them by
# name exempted whatever anyone later put in them, which round four
# demonstrated by appending a denied term to the canary and getting a clean
# result. scripts/gate/approved-exemptions.sha256 holds the sha256 of the
# approved contents of each one; anything else at those paths is scanned like
# any other file.
EXEMPTIONS = HERE / "approved-exemptions.sha256"

# There is no path the gate declines to read. A file only reaches the index or
# the history because somebody put it there, and `git add -f node_modules/...`
# was a way past the content scan. Directory skipping belongs to filesystem
# walking, in --path mode, and nowhere else.

WORD = re.compile(r"[a-z0-9]+")
NULL_SHA = "0" * 40


class GateBroken(Exception):
    """The gate cannot do its job. Never reported as clean."""


def die(message: str, code: int = 3) -> None:
    print(f"gate: {message}", file=sys.stderr)
    raise SystemExit(code)


# ---------------------------------------------------------------------------
# Loading the rules


def load_hashes() -> set[str]:
    if not DENYLIST.is_file():
        die(f"denylist missing at {DENYLIST}")
    hashes: set[str] = set()
    for raw in DENYLIST.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip().lower()
        if not line:
            continue
        if len(line) != 64 or not all(c in "0123456789abcdef" for c in line):
            die(f"denylist line is not a sha256: {raw!r}")
        hashes.add(line)
    if not hashes:
        die("denylist is empty; the gate would pass everything")
    return hashes


def load_globs(path: Path, what: str) -> list[str]:
    if not path.is_file():
        die(f"{what} missing at {path}")
    out: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            out.append(line)
    return out


def load_exemptions() -> dict[str, set[str]]:
    """path -> every sha256 the gate will skip at that path.

    A set, not a single digest: these fixtures legitimately change, each
    change is an approval, and the old bytes stay approved because they are
    still in the history the pre-push scan reads.
    """
    if not EXEMPTIONS.is_file():
        die(f"approved exemptions missing at {EXEMPTIONS}")
    out: dict[str, set[str]] = {}
    for raw in EXEMPTIONS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            die(f"exemption line is not '<sha256>  <path>': {raw!r}")
        out.setdefault(parts[1].strip(), set()).add(parts[0].lower())
    if not out:
        die("the exemption list is empty; the fixtures would fail every sweep")
    return out


def load_shape_rules() -> list[tuple[str, "re.Pattern[str]", str]]:
    if not SHAPE_RULES.is_file():
        die(f"shape rules missing at {SHAPE_RULES}")
    rules: list[tuple[str, re.Pattern[str], str]] = []
    for raw in SHAPE_RULES.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # Split on the first and last bar only: a regex is full of bars.
        if line.count("|") < 2:
            die(f"shape rule is not category|regex|description: {raw!r}")
        category, rest = line.split("|", 1)
        pattern, description = rest.rsplit("|", 1)
        category, pattern, description = (
            category.strip(),
            pattern.strip(),
            description.strip(),
        )
        if not category or not pattern or not description:
            die(f"shape rule has an empty field: {raw!r}")
        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            die(f"shape rule will not compile ({exc}): {raw!r}")
        rules.append((category, compiled, description))
    if not rules:
        die("no shape rules; the gate would pass a contact card")
    return rules


# ---------------------------------------------------------------------------
# Matching


def normalise(text: str) -> list[str]:
    return WORD.findall(text.lower())


def candidates(text: str):
    """Every 1 to MAX_NGRAM_WORDS word phrase in the text, normalised.

    Phrases are joined with a single space, and a term is hashed the same way
    when the list is built, so a multi word term matches whether the text
    separates the words with a space, an underscore, a hyphen or a full stop,
    and whatever the case.
    """
    words = normalise(text)
    for size in range(1, MAX_NGRAM_WORDS + 1):
        for i in range(len(words) - size + 1):
            phrase = " ".join(words[i : i + size])
            if len(phrase.replace(" ", "")) >= MIN_TERM_LENGTH:
                yield phrase


def digest(phrase: str) -> str:
    return hashlib.sha256(phrase.encode("utf-8")).hexdigest()


def fingerprint(text: str) -> str:
    """Enough to tell two findings apart, not enough to recover the term."""
    return f"{digest(text)[:8]}/{len(text)}"


def scan_text(text: str, hashes: set[str], shapes) -> list[tuple[str, str]]:
    """Return (category, matched text) for every hit. The caller decides
    whether the matched text is ever printed; by default it is not."""
    hits: list[tuple[str, str]] = []
    seen: set[str] = set()
    for phrase in candidates(text):
        if digest(phrase) in hashes and phrase not in seen:
            seen.add(phrase)
            hits.append(("denied term", phrase))
    for category, pattern, description in shapes:
        for match in pattern.finditer(text):
            value = match.group(0)
            key = f"{category}:{value}"
            if key in seen:
                continue
            seen.add(key)
            hits.append((f"shape, {category}: {description}", value))
    return hits


def read_path(path: Path) -> bytes | None:
    """The bytes git would store for this path.

    A symlink is not a file to open: git stores the target path as the blob,
    and opening it either follows the link or raises. Read the link itself,
    so a symlink is scanned for what it actually is and never counted as
    unreadable.
    """
    try:
        if path.is_symlink():
            return os.readlink(path).encode("utf-8", "surrogateescape")
        return path.read_bytes()
    except OSError:
        return None


def decode(data: bytes) -> str | None:
    """Text, or None when this is not text. None is a violation, not a skip."""
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


# ---------------------------------------------------------------------------
# Git


def git(args: list[str], cwd: Path | None = None) -> bytes:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=cwd or REPO,
            check=True,
            capture_output=True,
        ).stdout
    except FileNotFoundError as exc:
        raise GateBroken(f"git is not on PATH: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        raise GateBroken(
            f"git {' '.join(args)} failed: {exc.stderr.decode('utf-8', 'replace').strip()}"
        ) from exc


def zsplit(data: bytes) -> list[str]:
    return [p for p in data.decode("utf-8", "surrogateescape").split("\0") if p]


def tracked_files() -> list[str]:
    return zsplit(git(["ls-files", "-z"]))


def staged_files() -> list[str]:
    return zsplit(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]))


def staged_blob(path: str) -> bytes | None:
    """The bytes git will commit, read out of the index."""
    try:
        return subprocess.run(
            ["git", "show", f":{path}"],
            cwd=REPO,
            check=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError:
        return None


def cat_blob(sha: str) -> bytes | None:
    try:
        return subprocess.run(
            ["git", "cat-file", "blob", sha],
            cwd=REPO,
            check=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError:
        return None


def outgoing_commits(revs: list[str]) -> list[str]:
    """The commits a push would publish.

    Given explicit revisions, use them. Otherwise take every commit on a local
    branch that is not already on a remote-tracking branch; with no remote at
    all, that is the whole history, which is the correct answer before the
    first push.
    """
    # rev-list has no NUL output mode; its shas are newline separated.
    def lines(args: list[str]) -> list[str]:
        return [
            l.strip()
            for l in git(args).decode("utf-8", "replace").splitlines()
            if l.strip()
        ]

    if revs:
        return lines(["rev-list", *revs])
    out = lines(["rev-list", "--branches", "--not", "--remotes"])
    if out:
        return out
    return lines(["rev-list", "--all"])


def parents(commit: str) -> list[str]:
    out = git(["rev-list", "--parents", "-n", "1", commit]).decode("utf-8", "replace")
    return out.split()[1:]


def commit_blobs(commit: str) -> list[tuple[str, str]]:
    """Every (path, blob sha) this commit touched, both sides of the change.

    Both sides matters: the pre-image of a deletion is the last content that
    file ever had, and that is exactly the case a working-tree scan misses.

    Merges matter for a different reason. `git diff-tree` prints nothing at
    all for a merge commit unless it is asked to compare against a parent, so
    a value invented while resolving a conflict exists on neither parent,
    appears in no diff, and sails into the published history. Round four
    demonstrated it. Each parent is therefore compared separately, and a blob
    that differs from both shows up in both comparisons.
    """
    ps = parents(commit)
    if len(ps) > 1:
        found: list[tuple[str, str]] = []
        for parent in ps:
            found.extend(_raw_pairs(["diff-tree", "-r", "-M", "--no-commit-id", "--raw", "-z", parent, commit]))
        return found
    return _raw_pairs(
        ["diff-tree", "-r", "-M", "--root", "--no-commit-id", "--raw", "-z", commit]
    )


def _raw_pairs(args: list[str]) -> list[tuple[str, str]]:
    raw = git(args).decode("utf-8", "surrogateescape")
    fields = [f for f in raw.split("\0") if f != ""]
    found: list[tuple[str, str]] = []
    i = 0
    while i < len(fields):
        meta = fields[i]
        if not meta.startswith(":"):
            i += 1
            continue
        parts = meta.split()
        if len(parts) < 5:
            i += 1
            continue
        src_sha, dst_sha, status = parts[2], parts[3], parts[4]
        renamed = status[:1] in {"R", "C"}
        paths_taken = 2 if renamed else 1
        path_fields = fields[i + 1 : i + 1 + paths_taken]
        i += 1 + paths_taken
        if not path_fields:
            continue
        src_path = path_fields[0]
        dst_path = path_fields[-1]
        if src_sha != NULL_SHA:
            found.append((src_path, src_sha))
        if dst_sha != NULL_SHA:
            found.append((dst_path, dst_sha))
    return found


def commit_identities(commit: str) -> list[tuple[str, str]]:
    raw = git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", commit])
    parts = raw.decode("utf-8", "replace").rstrip("\n").split("\0")
    if len(parts) < 4:
        return []
    return [("author", f"{parts[0]} {parts[1]}"), ("committer", f"{parts[2]} {parts[3]}")]


# ---------------------------------------------------------------------------
# Reporting

Violation = tuple[str, str, str, str]  # where, kind, sanitised, raw


def report(violations: list[Violation], reveal: bool, scanned: str) -> int:
    if not violations:
        print(f"gate: clean ({scanned})")
        return 0
    print(f"gate: {len(violations)} violation(s) ({scanned})", file=sys.stderr)
    for where, kind, sanitised, raw in violations:
        shown = raw if reveal else sanitised
        print(f"  {where}: {kind}: {shown}", file=sys.stderr)
    if not reveal:
        print(
            "\ngate: matched text is withheld on purpose. This output goes into\n"
            "logs and transcripts. Re-run locally with --reveal to see it.",
            file=sys.stderr,
        )
    print(
        "\ngate: this is a stop, not a nuisance. Client material must never enter\n"
        "this history. Remove it from the history, not just from the commit.",
        file=sys.stderr,
    )
    return 1


# ---------------------------------------------------------------------------
# The checks


def path_violations(paths, patterns: list[str]) -> list[Violation]:
    """Path rules. Run on every path, before any content exclusion, because a
    directory the content scan skips must not hide a denied path."""
    out: list[Violation] = []
    for where, rel in paths:
        name = rel.rsplit("/", 1)[-1]
        for pattern in patterns:
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(name, pattern):
                out.append((where, "denied path", pattern, pattern))
                break
    return out


def content_violations(
    items, hashes: set[str], shapes, binary_allow: list[str], exemptions: dict[str, set[str]]
) -> list[Violation]:
    """items: an iterable of (where, rel, bytes-or-None)."""
    out: list[Violation] = []
    for where, rel, data in items:
        approved = exemptions.get(rel)
        if approved is not None and data is not None:
            if hashlib.sha256(data).hexdigest() in approved:
                continue
            # The path is exempt and these are not the approved bytes. Say so,
            # because "the canary changed" is a thing somebody must look at,
            # not a thing to scan quietly and maybe pass.
            out.append(
                (
                    where,
                    "exempt path, unapproved contents",
                    "scanned like any other file; update approved-exemptions.sha256 on purpose",
                    "scanned like any other file; update approved-exemptions.sha256 on purpose",
                )
            )
        name = rel.rsplit("/", 1)[-1]
        allowed_binary = any(
            fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(name, p) for p in binary_allow
        )
        if data is None:
            if allowed_binary:
                continue
            out.append(
                (
                    where,
                    "unreadable",
                    "the gate could not read this file",
                    "the gate could not read this file",
                )
            )
            continue
        text = decode(data)
        if text is None:
            if allowed_binary:
                continue
            out.append(
                (
                    where,
                    "binary or undecodable",
                    "not UTF-8 text, and not on the binary allowlist",
                    "not UTF-8 text, and not on the binary allowlist",
                )
            )
            continue
        for kind, value in scan_text(text, hashes, shapes):
            out.append((where, kind, fingerprint(value), value))
    return out


# ---------------------------------------------------------------------------
# Modes


def mode_staged(hashes, shapes, patterns, binary_allow, exemptions, reveal: bool) -> int:
    rels = staged_files()
    if not rels:
        print("gate: nothing staged")
        return 0
    violations = path_violations([(r, r) for r in rels], patterns)
    items = [(rel, rel, staged_blob(rel)) for rel in rels]
    violations += content_violations(items, hashes, shapes, binary_allow, exemptions)
    return report(violations, reveal, f"{len(rels)} staged blob(s)")


def mode_range(revs, hashes, shapes, patterns, binary_allow, exemptions, reveal: bool) -> int:
    commits = outgoing_commits(revs)
    if not commits:
        print("gate: nothing outgoing")
        return 0
    violations: list[Violation] = []
    pairs: dict[tuple[str, str], str] = {}
    for commit in commits:
        short = commit[:9]
        for path, sha in commit_blobs(commit):
            pairs.setdefault((path, sha), short)
        for role, identity in commit_identities(commit):
            for kind, value in scan_text(identity, hashes, shapes):
                violations.append(
                    (f"{short} ({role})", kind, fingerprint(value), value)
                )
    violations += path_violations(
        [(f"{where}:{path}", path) for (path, _sha), where in pairs.items()], patterns
    )
    items = [
        (f"{where}:{path}", path, cat_blob(sha))
        for (path, sha), where in pairs.items()
    ]
    violations += content_violations(items, hashes, shapes, binary_allow, exemptions)
    return report(
        violations, reveal, f"{len(pairs)} blob(s) in {len(commits)} outgoing commit(s)"
    )


def mode_tracked(hashes, shapes, patterns, binary_allow, exemptions, reveal: bool) -> int:
    rels = tracked_files()
    violations = path_violations([(r, r) for r in rels], patterns)
    items = [(rel, rel, read_path(REPO / rel)) for rel in rels]
    violations += content_violations(items, hashes, shapes, binary_allow, exemptions)
    return report(violations, reveal, f"{len(rels)} tracked file(s)")


def mode_path(target: Path, hashes, shapes, patterns, binary_allow, exemptions, reveal: bool) -> int:
    if not target.exists():
        die(f"no such path: {target}")
    found: list[Path] = []
    if target.is_file():
        found = [target]
    else:
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "dist"}]
            found.extend(Path(dirpath) / n for n in filenames)
    rels = [str(p) for p in found]
    violations = path_violations(list(zip(rels, rels)), patterns)
    items = [(rel, rel, read_path(path)) for path, rel in zip(found, rels)]
    violations += content_violations(items, hashes, shapes, binary_allow, exemptions)
    return report(violations, reveal, f"{len(found)} file(s) under {target}")


def mode_self_test(hashes, shapes, exemptions) -> int:
    """The gate proving itself, before any sweep result is believed.

    Three assertions, as the contamination audit set them out: the canary
    matches, every shape rule fires, and a missing private list is exit 2
    rather than a clean pass.
    """
    failures: list[str] = []

    if not CANARY_FILE.is_file():
        failures.append(f"the canary is missing at {CANARY_FILE}")
    else:
        text = CANARY_FILE.read_text(encoding="utf-8")
        terms = [v for k, v in scan_text(text, hashes, []) if k == "denied term"]
        if not terms:
            failures.append("the canary was not flagged; the hashed matcher is broken")
        else:
            widest = max(len(t.split()) for t in terms)
            print(f"gate: canary flagged on {len(terms)} phrase(s), widest {widest} word(s)")
            if widest < 4:
                failures.append(
                    f"the widest matched phrase is {widest} words; a four word entry "
                    "on the denylist could never match"
                )

    if not SHAPE_CANARY_FILE.is_file():
        failures.append(f"the shape canary is missing at {SHAPE_CANARY_FILE}")
    else:
        text = SHAPE_CANARY_FILE.read_text(encoding="utf-8")
        fired = {
            category
            for category, pattern, _d in shapes
            for _m in [pattern.search(text)]
            if _m
        }
        missed = [
            description
            for category, pattern, description in shapes
            if not pattern.search(text)
        ]
        print(
            f"gate: {len(shapes) - len(missed)} of {len(shapes)} shape rule(s) fired, "
            f"categories {sorted(fired)}"
        )
        for description in missed:
            failures.append(f"a shape rule never fired: {description}")

    # The exemption list must describe the fixtures as they are now. A stale
    # line means the gate is scanning a fixture it should skip, or skipping
    # bytes nobody approved.
    for rel, digests in sorted(exemptions.items()):
        path = REPO / rel
        if not path.is_file():
            failures.append(f"an exempt path does not exist: {rel}")
            continue
        current = hashlib.sha256(path.read_bytes()).hexdigest()
        if current not in digests:
            failures.append(
                f"{rel} is not in approved-exemptions.sha256 as it stands now.\n"
                f"    Its digest is {current}. Add that line on purpose, or find out\n"
                "    why the file changed."
            )
    print(f"gate: {len(exemptions)} exempt path(s), all matching an approved digest")

    absent = Path("/nonexistent/gate-terms-that-are-not-there.txt")
    code = literal_sweep_status(absent)
    print(f"gate: a missing private list exits {code}")
    if code != 2:
        failures.append(f"a missing private list exited {code}, not 2")

    if failures:
        print("gate: SELF-TEST FAILED", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        print(
            "\ngate: no sweep result can be trusted while this fails. A blind gate\n"
            "that has stopped working looks exactly like a clean repository.",
            file=sys.stderr,
        )
        return 1
    print("gate: self-test passed")
    return 0


def literal_sweep_status(listfile: Path) -> int:
    return 2 if not listfile.is_file() else 0


def mode_literal(revs, patterns: list[str], reveal: bool) -> int:
    """The maintainer-only clear-text sweep. Second layer, not the only one.

    It needs the private list and refuses to pretend when it is absent.
    """
    location = os.environ.get(LITERAL_LIST_ENV)
    listfile = Path(location) if location else None
    if listfile is None or not listfile.is_file():
        print(
            "gate: no readable private clear-text list was supplied.\n"
            f"gate: set {LITERAL_LIST_ENV} to its path, or run this on a maintainer\n"
            "gate: machine. Exiting 2: the literal sweep did not run.",
            file=sys.stderr,
        )
        return 2
    terms = [
        line.strip().lower()
        for line in listfile.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    terms = [t for t in terms if len(t.replace(" ", "")) >= 3]
    if not terms:
        die("the clear-text list is empty")
    commits = outgoing_commits(revs)
    pairs: dict[tuple[str, str], str] = {}
    for commit in commits:
        for path, sha in commit_blobs(commit):
            pairs.setdefault((path, sha), commit[:9])
    violations: list[Violation] = []
    violations += path_violations(
        [(f"{where}:{path}", path) for (path, _s), where in pairs.items()], patterns
    )
    for (path, sha), where in pairs.items():
        data = cat_blob(sha)
        text = decode(data) if data is not None else None
        if text is None:
            violations.append(
                (f"{where}:{path}", "unreadable", "not readable as text", "not readable as text")
            )
            continue
        haystack = " ".join(normalise(text))
        for term in terms:
            needle = " ".join(normalise(term))
            if needle and needle in haystack:
                violations.append(
                    (f"{where}:{path}", "denied term, literal", fingerprint(term), term)
                )
    return report(
        violations,
        reveal,
        f"literal, {len(pairs)} blob(s) in {len(commits)} outgoing commit(s), {len(terms)} term(s)",
    )


# ---------------------------------------------------------------------------


class Parser(argparse.ArgumentParser):
    """Argparse exits 2 on a usage error, and 2 already means "the private
    list is absent" here. A hook reading exit codes must not confuse the two,
    so a bad argument exits 3 with the rest of the gate's own breakage."""

    def error(self, message: str) -> None:  # type: ignore[override]
        die(f"bad arguments: {message}")


def main() -> int:
    parser = Parser(description="The contamination gate.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--self-test", action="store_true", help="prove the gate works")
    group.add_argument("--staged", action="store_true", help="read the staged blobs")
    group.add_argument("--range", action="store_true", help="read the outgoing commits")
    group.add_argument("--literal", action="store_true", help="maintainer clear-text sweep")
    group.add_argument("--path", type=Path, help="sweep one path anywhere on disk")
    parser.add_argument(
        "--reveal",
        action="store_true",
        help="print the matched text. Local use only; never in continuous integration.",
    )
    parser.add_argument("revs", nargs="*", help="revisions for --range")
    args = parser.parse_args()

    try:
        patterns = load_globs(PATH_DENYLIST, "path denylist")
        binary_allow = load_globs(BINARY_ALLOWLIST, "binary allowlist")

        if args.literal:
            return mode_literal(args.revs, patterns, args.reveal)

        hashes = load_hashes()
        shapes = load_shape_rules()
        exemptions = load_exemptions()

        if args.self_test:
            return mode_self_test(hashes, shapes, exemptions)
        if args.staged:
            return mode_staged(hashes, shapes, patterns, binary_allow, exemptions, args.reveal)
        if args.range:
            return mode_range(args.revs, hashes, shapes, patterns, binary_allow, exemptions, args.reveal)
        if args.path is not None:
            return mode_path(args.path, hashes, shapes, patterns, binary_allow, exemptions, args.reveal)
        return mode_tracked(hashes, shapes, patterns, binary_allow, exemptions, args.reveal)
    except GateBroken as exc:
        die(str(exc))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
