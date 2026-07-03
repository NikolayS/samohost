/**
 * test/secret-deny-hook.test.ts — Red/Green TDD for the PreToolUse secret-deny hook.
 *
 * The hook lives at tools/hooks/secret-deny.py. It reads a JSON Claude Code
 * tool-call payload on stdin and writes {"permissionDecision":"deny"|"allow"}
 * on stdout.
 *
 * This test file is the RED commit. All tests fail until secret-deny.py exists.
 *
 * Playwright note: this is a headless CLI tool with no browser surface; a CLI
 * subprocess e2e (Bun.spawn) satisfies the integration requirement per the
 * doctor.test.ts precedent in this repo.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_PATH = join(REPO_ROOT, "tools/hooks/secret-deny.py");
const SETTINGS_SNIPPET_PATH = join(REPO_ROOT, "tools/hooks/settings.snippet.json");

// ---------------------------------------------------------------------------
// Helper: run the hook with a given payload, return parsed JSON output.
// ---------------------------------------------------------------------------
async function runHook(
  payload: unknown,
): Promise<{ permissionDecision: string; reason?: string }> {
  const proc = Bun.spawn(["python3", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const encoder = new TextEncoder();
  proc.stdin.write(encoder.encode(JSON.stringify(payload)));
  proc.stdin.end();
  const [raw] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  const parsed = JSON.parse(raw.trim());
  return parsed;
}

// ---------------------------------------------------------------------------
// Artifact existence
// ---------------------------------------------------------------------------
describe("hook artifacts", () => {
  test("secret-deny.py exists", () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  test("settings.snippet.json exists", () => {
    expect(existsSync(SETTINGS_SNIPPET_PATH)).toBe(true);
  });

  test("settings snippet is valid JSON with hooks.PreToolUse", () => {
    const raw = require(SETTINGS_SNIPPET_PATH);
    expect(raw).toHaveProperty("hooks");
    expect(raw.hooks).toHaveProperty("PreToolUse");
    expect(Array.isArray(raw.hooks.PreToolUse)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DENY cases — Write tool
// ---------------------------------------------------------------------------
describe("hook DENY — Write tool", () => {
  test("Cloudflare user-token prefix cfut_", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/config.env",
        content: "CF_TOKEN=cfut_fake1234567890abcdefXYZ\n",
      },
    });
    expect(result.permissionDecision).toBe("deny");
    expect(result.reason).toBeDefined();
  });

  test("GitHub PAT prefix ghp_", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/gh.env",
        content: 'export GH_TOKEN="ghp_fakeGitHubTokenABCDEF12345678901234"\n',
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("GitLab PAT prefix glpat-", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/gl.env",
        content: 'GL_TOKEN=glpat-fakeGitLabToken12345678ABCD\n',
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("OpenAI key prefix sk-", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/.env",
        content: "OPENAI_API_KEY=sk-fakeopenaikey1234567890abcdefghij\n",
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("AWS access key ID prefix AKIA", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/aws.env",
        content: "AWS_ACCESS_KEY_ID=AKIAFAKEAWSKEY12345678\n",
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("PEM RSA private-key header", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/id_rsa",
        content:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAfakekey...\n-----END RSA PRIVATE KEY-----\n",
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("PEM generic private-key header (OPENSSH)", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/id_ed25519",
        content:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAA...\n-----END OPENSSH PRIVATE KEY-----\n",
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// DENY cases — Edit tool (new_string inspected, not old_string)
// ---------------------------------------------------------------------------
describe("hook DENY — Edit tool", () => {
  test("high-entropy value assigned to *PASSWORD variable", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/config.ts",
        old_string: 'const DB_PASSWORD = ""',
        // 32-char all-unique string: Shannon entropy ≈ 5 bits — above 3.5 threshold
        new_string: 'const DB_PASSWORD = "xK9mN2pQ7vRtY1wZ3bL8hJ0cA5dF6gE"',
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });

  test("token prefix in new_string — ghp_ in Edit", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/deploy.sh",
        old_string: "GH_TOKEN=placeholder",
        new_string: "GH_TOKEN=ghp_fakeGitHubTokenABCDEF12345678901234",
      },
    });
    expect(result.permissionDecision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// ALLOW cases
// ---------------------------------------------------------------------------
describe("hook ALLOW — clean payloads", () => {
  test("Write with clean prose content", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/readme.md",
        content:
          "# Hello world\nThis document contains no secrets and is safe to write.\n",
      },
    });
    expect(result.permissionDecision).toBe("allow");
  });

  test("Edit with numeric-only timeout change", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/config.ts",
        old_string: "const timeout = 30",
        new_string: "const timeout = 60",
      },
    });
    expect(result.permissionDecision).toBe("allow");
  });

  test("non-Write/Edit tool (Bash) — allowed regardless of content", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: {
        // would be flagged if it were a Write, but Bash calls are not inspected
        command: "echo ghp_ prefix in a bash echo is not a committed secret",
      },
    });
    expect(result.permissionDecision).toBe("allow");
  });

  test("Write with a low-entropy password placeholder", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/config.env",
        // All same chars → entropy ≈ 0 → should not trigger entropy rule
        content: 'DB_PASSWORD="aaaaaaaaaaaaaaaa"\n',
      },
    });
    expect(result.permissionDecision).toBe("allow");
  });

  test("old_string in Edit is not inspected even if it contains a pattern", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/config.sh",
        // old_string has the secret (already in the file), new_string is clean
        old_string: "GH_TOKEN=ghp_fakeGitHubTokenABCDEF12345678901234",
        new_string: 'GH_TOKEN="${GH_TOKEN}"',
      },
    });
    // Hook only checks new_string (what's being written), not old_string
    expect(result.permissionDecision).toBe("allow");
  });
});
