#!/usr/bin/env python3
"""PreToolUse guard — fence the `ux-designer` subagent's Edit/Write to
artifacts/mockup-sandbox/.

Enforces (at the tool layer) the prompt-level rule that ux-designer only
prototypes in the sandbox and never touches production source. ONLY affects
agent_type == "ux-designer"; every other subagent and the main session pass
through untouched. Never breaks tool flow on unexpected input (exits 0).
"""
import json
import os
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # malformed input must not block tools

# Only fence the ux-designer agent. Main session + all other agents: allow.
if data.get("agent_type") != "ux-designer":
    sys.exit(0)

tool_input = data.get("tool_input") or {}
fp = tool_input.get("file_path")
if not fp:
    sys.exit(0)

project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
sandbox = os.path.abspath(os.path.join(project_dir, "artifacts", "mockup-sandbox"))
target = os.path.abspath(fp if os.path.isabs(fp) else os.path.join(project_dir, fp))

# Inside the sandbox (or the sandbox dir itself) — allow.
if target == sandbox or target.startswith(sandbox + os.sep):
    sys.exit(0)

# Outside — deny with a reason routing the change to the right agent.
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"ux-designer is fenced to artifacts/mockup-sandbox/. "
            f"Blocked {data.get('tool_name', 'edit')} to {target}. "
            f"Hand production changes to frontend-engineer."
        ),
    }
}))
sys.exit(0)
