# SPDX-License-Identifier: AGPL-3.0-only
"""Exact historical literal decisions. The approval receipt stays outside Git."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

RECEIPT_ENV = "HUB_GATE_LITERAL_HISTORY_RECEIPT"
OID = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")
DECISION = re.compile(r"[A-Z][A-Z0-9_-]{1,79}")


def checked_git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, timeout=10, env=dict(os.environ, LC_ALL="C"))


class HistoricalLiterals:
    def __init__(self, repo: Path, anchor: str, entries: set[tuple[str, str, str]], tips: set[str]):
        self.repo = repo
        self.anchor = anchor
        self.entries = entries
        self.tips = tips
        self.ancestry: dict[str, bool] = {}
        self.allowed = 0
        self.tip_blobs: dict[tuple[str, str], str] = {}

    @classmethod
    def load(cls, repo: Path, approvals: Path, revs: list[str]) -> HistoricalLiterals:
        location = os.environ.get(RECEIPT_ENV)
        if not location:
            return cls(repo, "", set(), set())
        receipt = Path(location).resolve(strict=True)
        if not receipt.is_file() or receipt.is_relative_to(repo.resolve()):
            raise ValueError("historical literal receipt must be external")
        outside = checked_git(receipt.parent, "rev-parse", "--show-toplevel")
        if outside.returncode == 0:
            raise ValueError("historical literal receipt must be outside Git")
        if outside.returncode != 128 or not outside.stderr.startswith(b"fatal: not a git repository") :
            raise ValueError("cannot verify external historical literal receipt")
        raw = receipt.read_bytes()
        if len(raw) > 65536:
            raise ValueError("historical literal receipt is too large")
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {"version", "anchor", "nonce", "entries"}:
            raise ValueError("invalid historical literal receipt")
        anchor, nonce, rows = data["anchor"], data["nonce"], data["entries"]
        if type(data["version"]) is not int or data["version"] != 1:
            raise ValueError("invalid historical literal version")
        if not isinstance(anchor, str) or not OID.fullmatch(anchor):
            raise ValueError("invalid historical literal anchor")
        if not isinstance(nonce, str) or not DIGEST.fullmatch(nonce):
            raise ValueError("invalid historical literal receipt nonce")
        commitment = hashlib.sha256(raw).hexdigest()
        approved = False
        approval_count = 0
        for line in approvals.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            approval_count += 1
            if approval_count > 1:
                raise ValueError("only one historical literal decision is supported")
            columns = line.split()
            if len(columns) != 3 or not DIGEST.fullmatch(columns[0]) or not OID.fullmatch(columns[1]) or not DECISION.fullmatch(columns[2]):
                raise ValueError("invalid historical literal approval registry")
            approved |= columns[:2] == [commitment, anchor]
        if not approved:
            raise ValueError("historical literal receipt is not explicitly approved")
        if checked_git(repo, "cat-file", "-t", anchor).stdout.strip() != b"commit":
            raise ValueError("historical literal anchor is not a commit")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 2:
            raise ValueError("historical literal receipt needs one or two tuples")
        entries: set[tuple[str, str, str]] = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"path", "blob", "term_sha256"}:
                raise ValueError("invalid historical literal tuple")
            path, blob, term = row["path"], row["blob"], row["term_sha256"]
            if not isinstance(path, str) or not path or path.startswith("/") or any(p in {"", ".", ".."} for p in path.split("/")) or "\\" in path or any(ord(c) < 32 for c in path):
                raise ValueError("invalid historical literal path")
            if not isinstance(blob, str) or not OID.fullmatch(blob) or not isinstance(term, str) or not DIGEST.fullmatch(term):
                raise ValueError("invalid historical literal tuple digest")
            if checked_git(repo, "cat-file", "-t", blob).stdout.strip() != b"blob":
                raise ValueError("historical literal tuple is not a blob")
            entries.add((path, blob, term))
        if len(entries) != len(rows):
            raise ValueError("duplicate historical literal tuple")
        if len({p for p, _b, _t in entries}) != 1 or len({t for _p, _b, t in entries}) != 1:
            raise ValueError("historical literal decision is limited to one path and term")
        if not revs:
            raise ValueError("historical approval requires explicit candidate tips")
        tips: set[str] = set()
        for rev in revs:
            if rev.startswith("^") or "..." in rev:
                raise ValueError("ambiguous historical candidate selection")
            parts = rev.split("..")
            if len(parts) > 2 or any(not part for part in parts):
                raise ValueError("ambiguous historical candidate selection")
            candidate = checked_git(repo, "rev-parse", "--verify", "--end-of-options", parts[-1] + "^{commit}")
            tip = candidate.stdout.strip().decode("ascii")
            if candidate.returncode != 0 or not OID.fullmatch(tip):
                raise ValueError("cannot prove historical candidate tip")
            tips.add(tip)
        return cls(repo, anchor, entries, tips)

    def tip_blob(self, tip: str, path: str) -> str:
        key = (tip, path)
        if key not in self.tip_blobs:
            row = checked_git(self.repo, "ls-tree", "-z", tip, "--", ":(literal)" + path)
            if row.returncode != 0:
                raise ValueError("cannot verify selected candidate path")
            self.tip_blobs[key] = row.stdout.split(b"\t", 1)[0].split()[-1].decode("ascii") if row.stdout else ""
        return self.tip_blobs[key]

    def refused_tips(self) -> list[tuple[str, str]]:
        return sorted({(tip, path) for path, blob, _term in self.entries for tip in self.tips if self.tip_blob(tip, path) == blob})

    def permits(self, path: str, blob: str, needle: str, occurrences: set[str]) -> bool:
        term = hashlib.sha256(needle.encode("utf-8")).hexdigest()
        if (path, blob, term) not in self.entries or not occurrences:
            return False
        if any(self.tip_blob(tip, path) == blob for tip in self.tips):
            return False
        for commit in occurrences:
            if commit not in self.ancestry:
                result = checked_git(self.repo, "merge-base", "--is-ancestor", commit, self.anchor)
                if result.returncode not in (0, 1):
                    raise ValueError("cannot verify historical literal ancestry")
                self.ancestry[commit] = result.returncode == 0
            if not self.ancestry[commit]:
                return False
        self.allowed += 1
        return True
