#!/usr/bin/env python3
"""
PreToolUse secret-deny hook for Claude Code.

Reads a Claude Code tool-call JSON payload from stdin and writes a
permission decision JSON object to stdout.

Decision logic:
  - Only Write and Edit tool calls are inspected.
  - Write: inspects tool_input.content
  - Edit:  inspects tool_input.new_string  (old_string is already in the
           repo; only the new content can introduce a NEW secret)
  - All other tools → immediate allow.

Patterns that trigger DENY:
  1. Token prefixes:  cfut_  ghp_  glpat-  sk-  AKIA
  2. PEM private-key headers: -----BEGIN (RSA|EC|DSA|OPENSSH)? PRIVATE KEY-----
  3. High-entropy values (Shannon entropy > 3.5 bits) assigned to variables
     whose names contain TOKEN, KEY, SECRET, PASSWORD, PASSWD, or PWD.

Exit code is always 0; the permissionDecision field carries the verdict.
A non-zero exit would also block the tool call but would suppress the
reason string that Claude Code shows to the user.
"""

from __future__ import annotations

import json
import math
import re
import sys
from typing import Optional


# ---------------------------------------------------------------------------
# Pattern 1 — well-known token prefixes
# ---------------------------------------------------------------------------
_PREFIX_RE = re.compile(
    r"""
    (?:
      cfut_   [A-Za-z0-9\-_]{8,}    # Cloudflare user API token
    | ghp_    [A-Za-z0-9]{20,}      # GitHub personal access token (spec=36; 20+ catches truncated)
    | glpat-  [A-Za-z0-9\-_]{20,}   # GitLab personal access token
    | sk-     [A-Za-z0-9]{20,}      # OpenAI / Anthropic key
    | AKIA    [0-9A-Z]{16}          # AWS access key ID
    )
    """,
    re.VERBOSE | re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Pattern 2 — PEM private-key block headers
# ---------------------------------------------------------------------------
_PEM_RE = re.compile(
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Pattern 3 — high-entropy value assigned to a sensitive variable name
#
# Matches:  <identifier-ending-in-keyword>  =  "value"
# where the value is at least 16 chars and has Shannon entropy > THRESHOLD.
#
# The regex captures just the value (group 1).
# ---------------------------------------------------------------------------
_SENSITIVE_VAR_RE = re.compile(
    r"""
    [A-Za-z_][A-Za-z0-9_]*         # start of variable name
    (?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD)  # sensitive keyword suffix
    \s*[=:]\s*                      # assignment or colon
    ["']([^"']{16,})["']            # quoted value ≥ 16 chars (captured)
    """,
    re.VERBOSE | re.IGNORECASE | re.MULTILINE,
)

_ENTROPY_THRESHOLD = 3.5


def _shannon_entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    n = len(s)
    return -sum((f / n) * math.log2(f / n) for f in freq.values())


def _check(content: str) -> Optional[str]:
    """Return a denial-reason string, or None if content is clean."""

    # Pattern 1: token prefixes
    m = _PREFIX_RE.search(content)
    if m:
        prefix = m.group(0)[:10]
        return f"Secret token prefix detected: {prefix!r} — do not commit tokens to files"

    # Pattern 2: PEM private-key header
    if _PEM_RE.search(content):
        return "PEM private-key block detected — private keys must never be written to disk via Claude Code"

    # Pattern 3: high-entropy sensitive variable assignment
    for match in _SENSITIVE_VAR_RE.finditer(content):
        val = match.group(1)
        h = _shannon_entropy(val)
        if h > _ENTROPY_THRESHOLD:
            # Show only the length and entropy — never the value itself
            var_fragment = match.group(0).split("=")[0].strip()
            return (
                f"High-entropy value (entropy={h:.2f} bits, len={len(val)}) "
                f"assigned to sensitive variable '{var_fragment}' — "
                f"use an environment-variable reference instead"
            )

    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        # Malformed input — pass through; Claude Code handles it
        _allow()
        return

    tool: str = payload.get("tool_name", "")
    tool_input: dict = payload.get("tool_input", {})

    if tool == "Write":
        content = tool_input.get("content", "")
    elif tool == "Edit":
        # Only inspect the new content being introduced, not old_string
        content = tool_input.get("new_string", "")
    else:
        _allow()
        return

    reason = _check(content)
    if reason:
        _deny(reason)
    else:
        _allow()


def _allow() -> None:
    print(json.dumps({"permissionDecision": "allow"}))


def _deny(reason: str) -> None:
    print(json.dumps({"permissionDecision": "deny", "reason": reason}))


if __name__ == "__main__":
    main()
