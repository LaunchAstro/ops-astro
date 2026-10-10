#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic CLI controls. No private list, network or real repository history."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

GATE_SOURCE = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "scripts/gate"


class LiteralHistoryCases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="literal-history-synthetic-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        shutil.copytree(GATE_SOURCE, self.repo / "scripts/gate")
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Synthetic Gate Test")
        self.git("config", "user.email", "gate-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.terms = self.root / "synthetic-terms.txt"
        self.terms.write_text("qovu\n")
        self.receipt = self.root / "synthetic-receipt.json"
        self.path = "fixture.txt"
        self.old = "synthetic qovu value\n"
        self.write(self.path, self.old)
        self.commit()
        self.blob = self.git("rev-parse", "HEAD:" + self.path)
        self.write(self.path, "clean fixture\n")
        self.commit()
        self.anchor = self.git("rev-parse", "HEAD")
        self.approve()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        p = subprocess.run(["git", *args], cwd=self.repo, text=True, capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0, "synthetic git failed")
        return p.stdout.strip()

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "synthetic fixture")

    def approve(self, **overrides):
        entry = {"path": self.path, "blob": self.blob, "term_sha256": hashlib.sha256(b"qovu").hexdigest()}
        entry.update(overrides)
        data = {"version": 1, "anchor": self.anchor, "nonce": "13" * 32, "entries": [entry]}
        self.receipt.write_text(json.dumps(data, sort_keys=True) + "\n")
        self.bind_receipt()

    def bind_receipt(self):
        digest = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.write("scripts/gate/literal-history-approvals.sha256", f"{digest} {self.anchor} SYNTHETIC_TEST_ONLY\n")

    def scan(self, expected, receipt=True, terms=True, rev="HEAD", git_env=None):
        env = dict(os.environ)
        env.pop("HUB_GATE_LITERAL_HISTORY_RECEIPT", None)
        env.pop("HUB_GATE_TERMS", None)
        if receipt:
            env["HUB_GATE_LITERAL_HISTORY_RECEIPT"] = str(self.receipt)
        if terms:
            env["HUB_GATE_TERMS"] = str(self.terms)
        env.update(git_env or {})
        p = subprocess.run([sys.executable, "scripts/gate/sweep.py", "--literal", rev], cwd=self.repo, env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, expected, p.stdout + p.stderr)
        self.assertNotIn("qovu", p.stdout + p.stderr)
        self.assertNotIn("zefa", p.stdout + p.stderr)
        return p.stdout + p.stderr

    def test_exact_historical_match(self):
        self.assertIn("1 approved historical match(es)", self.scan(0))

    def linked_hook_env(self):
        linked = self.root / "linked"
        self.git("worktree", "add", "-q", "-b", "linked", str(linked))
        registry = "scripts/gate/literal-history-approvals.sha256"
        shutil.copyfile(self.repo / registry, linked / registry)
        self.repo = linked
        return {
            "GIT_DIR": self.git("rev-parse", "--absolute-git-dir"),
            "GIT_COMMON_DIR": self.git("rev-parse", "--path-format=absolute", "--git-common-dir"),
            "GIT_WORK_TREE": str(linked),
            "GIT_INDEX_FILE": self.git("rev-parse", "--path-format=absolute", "--git-path", "index"),
        }

    def test_linked_worktree_hook_environment(self):
        hook_env = self.linked_hook_env()
        self.assertIn("1 approved historical match(es)", self.scan(0, git_env=hook_env))

    def test_linked_worktree_hook_environment_other_git_receipt_refused(self):
        hook_env = self.linked_hook_env()
        other = self.root / "other"
        other.mkdir()
        created = subprocess.run(["git", "init", "-q", str(other)], capture_output=True, timeout=10)
        self.assertEqual(created.returncode, 0)
        copied = other / self.receipt.name
        shutil.copyfile(self.receipt, copied)
        self.receipt = copied
        self.scan(3, git_env=hook_env)

    def test_cli_does_not_write_bytecode(self):
        self.scan(0)
        self.assertFalse(
            (self.repo / "scripts/gate/__pycache__").exists(),
            "gate CLI generated untracked bytecode",
        )

    def test_default_refusal(self):
        self.scan(1, receipt=False)

    def test_missing_private_list_is_honest_absence(self):
        self.scan(2, terms=False)

    def test_unapproved_receipt(self):
        self.write("scripts/gate/literal-history-approvals.sha256", "# no approvals\n")
        self.scan(3)

    def test_receipt_tampering(self):
        data = json.loads(self.receipt.read_text())
        data["nonce"] = "14" * 32
        self.receipt.write_text(json.dumps(data))
        self.scan(3)

    def test_same_blob_at_new_path(self):
        self.write("other.txt", self.old)
        self.commit()
        self.write("other.txt", "clean other fixture\n")
        self.commit()
        self.anchor = self.git("rev-parse", "HEAD")
        self.approve()
        self.scan(1)

    def test_changed_blob_same_path(self):
        self.write(self.path, self.old + "different bytes\n")
        self.commit()
        self.write(self.path, "clean changed fixture\n")
        self.commit()
        self.anchor = self.git("rev-parse", "HEAD")
        self.approve()
        self.scan(1)

    def test_same_blob_reintroduced_after_anchor(self):
        self.write(self.path, self.old)
        self.commit()
        self.scan(1)

    def test_approved_old_blob_at_historical_current_tip_refused(self):
        self.git("checkout", "-q", self.anchor + "^")
        self.bind_receipt()
        self.scan(1)

    def test_head_clean_explicit_historical_tip_refused(self):
        self.assertEqual(self.git("show", "HEAD:" + self.path), "clean fixture")
        old_tip = self.git("rev-parse", self.anchor + "^")
        self.scan(1, rev=old_tip)

    def test_head_clean_range_ending_at_historical_tip_refused(self):
        self.git("commit", "--allow-empty", "-qm", "clean synthetic successor")
        clean = self.git("rev-parse", "HEAD")
        old_tip = self.git("rev-parse", self.anchor + "^")
        self.scan(1, rev=clean + ".." + old_tip)

    def test_head_dirty_but_actual_selected_tip_clean(self):
        clean_tip = self.anchor
        self.git("checkout", "-q", self.anchor + "^")
        self.bind_receipt()
        self.scan(0, rev=clean_tip)

    def test_one_of_multiple_selected_tips_dirty_refused(self):
        env = dict(os.environ, HUB_GATE_TERMS=str(self.terms), HUB_GATE_LITERAL_HISTORY_RECEIPT=str(self.receipt))
        old_tip = self.git("rev-parse", self.anchor + "^")
        p = subprocess.run([sys.executable, "scripts/gate/sweep.py", "--literal", self.anchor, old_tip], cwd=self.repo, env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertNotIn("qovu", p.stdout + p.stderr)

    def test_ambiguous_approved_selection_refused(self):
        self.scan(3, rev=self.anchor + "...HEAD")

    def test_after_anchor_preimage_is_also_refused(self):
        self.write(self.path, self.old)
        self.commit()
        dirty = self.git("rev-parse", "HEAD")
        self.write(self.path, "clean again\n")
        self.commit()
        self.scan(1, rev=dirty + "..HEAD")

    def test_another_term_in_exact_approved_blob(self):
        original_blob = self.blob
        self.write(self.path, "synthetic qovu and zefa value\n")
        self.commit()
        self.blob = self.git("rev-parse", "HEAD:" + self.path)
        self.write(self.path, "clean fixture again\n")
        self.commit()
        self.anchor = self.git("rev-parse", "HEAD")
        self.approve()
        data = json.loads(self.receipt.read_text())
        first = dict(data["entries"][0], blob=original_blob)
        data["entries"].append(first)
        self.receipt.write_text(json.dumps(data))
        self.bind_receipt()
        self.terms.write_text("qovu\nzefa\n")
        output = self.scan(1)
        self.assertIn("2 approved historical match(es)", output)
        self.assertIn(hashlib.sha256(b"zefa").hexdigest()[:8] + "/4", output)

    def test_wrong_exact_tuple(self):
        self.approve(term_sha256=hashlib.sha256(b"zefa").hexdigest())
        self.scan(1)

    def test_denied_path_still_fails(self):
        self.write("gate-terms.txt", self.old)
        self.commit()
        self.path = "gate-terms.txt"
        self.anchor = self.git("rev-parse", "HEAD")
        self.approve()
        self.assertIn("denied path", self.scan(1))

    def test_unreadable_content_still_fails(self):
        (self.repo / "binary.txt").write_bytes(b"\x00\xff")
        self.commit()
        self.assertIn("unreadable", self.scan(1))

    def test_receipt_inside_git_refused(self):
        internal = self.repo / "private-receipt.json"
        shutil.copyfile(self.receipt, internal)
        self.receipt = internal
        self.scan(3)

    def test_missing_receipt_refused(self):
        self.receipt.unlink()
        self.scan(3)

    def test_malformed_but_committed_receipt_refused(self):
        self.receipt.write_text("{}\n")
        self.bind_receipt()
        self.scan(3)

    def test_multiple_approval_rows_refused(self):
        registry = self.repo / "scripts/gate/literal-history-approvals.sha256"
        registry.write_text(registry.read_text() * 2)
        self.scan(3)

    def test_duplicate_tuple_refused(self):
        data = json.loads(self.receipt.read_text())
        data["entries"] *= 2
        self.receipt.write_text(json.dumps(data))
        self.bind_receipt()
        self.scan(3)

    def test_noncommit_anchor_refused(self):
        self.anchor = self.blob
        self.approve()
        self.scan(3)

    def test_approval_does_not_relax_other_modes(self):
        self.write("gate-terms.txt", "clean bytes\n")
        self.git("add", "gate-terms.txt")
        env = dict(os.environ, HUB_GATE_LITERAL_HISTORY_RECEIPT=str(self.receipt))
        p = subprocess.run([sys.executable, "scripts/gate/sweep.py", "--staged"], cwd=self.repo, env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("denied path", p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
