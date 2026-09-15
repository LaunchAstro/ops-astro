#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Read the project memory policy, without claiming effective session state."""

import sys
import tomllib
from pathlib import Path


def memory_policy_is_off(path: Path) -> bool:
    try:
        with path.open("rb") as source:
            config = tomllib.load(source)
        features = config.get("features", {})
        memories = config.get("memories", {})
        return (
            isinstance(features, dict)
            and isinstance(memories, dict)
            and features.get("memories") is False
            and memories.get("generate_memories") is False
            and memories.get("use_memories") is False
        )
    except (OSError, tomllib.TOMLDecodeError):
        return False


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(2)
    sys.exit(0 if memory_policy_is_off(Path(sys.argv[1])) else 1)
