// tests/unit/cli/profile-commands.test.ts
//
// Integration coverage for the `profile` CLI subcommands (create / list /
// switch / delete). Exercises registerProfileCommands() against a fresh
// commander program and a temp HERMES_HOME, asserting on filesystem effects
// and captured console output. The CLI entrypoint (cli.ts) parses argv on
// import, so the command wiring lives in a separate module to keep it testable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("dotenv", () => ({ config: vi.fn() }));

import { registerProfileCommands } from "../../../src/cli/commands/profile";
import { resetConfigProfileManager } from "../../../src/config/profile-manager";

let tmpHome: string;
let savedHome: string | undefined;
let logs: string[];
let errors: string[];

function run(...args: string[]): Promise<void> {
  // Each invocation gets its own program: commander does not support
  // re-registering the same subcommands on a reused instance.
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerProfileCommands(program);
  return program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  savedHome = process.env.HERMES_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cli-profile-"));
  process.env.HERMES_HOME = tmpHome;
  // The config ProfileManager is a singleton that captures its root at
  // construction — reset it so it re-reads the temp HERMES_HOME.
  resetConfigProfileManager();

  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigProfileManager();
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  process.exitCode = undefined;
});

describe("profile CLI commands", () => {
  it("create scaffolds the profile directory", async () => {
    await run("profile", "create", "researcher");

    const dir = path.join(tmpHome, "profiles", "researcher");
    expect(fs.existsSync(path.join(dir, "memories"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sessions"))).toBe(true);
    expect(logs.join("\n")).toContain("Created profile 'researcher'");
  });

  it("create reports an error for a duplicate profile", async () => {
    await run("profile", "create", "dup");
    await run("profile", "create", "dup");

    expect(errors.join("\n")).toMatch(/already exists/i);
    expect(process.exitCode).toBe(1);
  });

  it("create rejects an invalid profile name", async () => {
    await run("profile", "create", "../escape");
    expect(errors.join("\n")).toMatch(/invalid profile name/i);
    expect(fs.existsSync(path.join(tmpHome, "escape"))).toBe(false);
  });

  it("list shows profiles and marks the active one", async () => {
    await run("profile", "create", "alpha");
    await run("profile", "create", "beta");
    logs.length = 0;

    await run("profile", "list");

    const out = logs.join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    // default is auto-created and active, so it carries the '*' marker.
    expect(out).toMatch(/\*\s+default/);
  });

  it("switch updates the active marker file", async () => {
    await run("profile", "create", "work");
    await run("profile", "switch", "work");

    const marker = path.join(tmpHome, "profiles", "active");
    expect(fs.readFileSync(marker, "utf-8").trim()).toBe("work");
    expect(logs.join("\n")).toContain("Switched active profile to 'work'");
  });

  it("switch errors on an unknown profile", async () => {
    await run("profile", "switch", "ghost");
    expect(errors.join("\n")).toMatch(/not found/i);
    expect(process.exitCode).toBe(1);
  });

  it("delete removes a non-active profile", async () => {
    await run("profile", "create", "temp");
    await run("profile", "delete", "temp");

    expect(fs.existsSync(path.join(tmpHome, "profiles", "temp"))).toBe(false);
    expect(logs.join("\n")).toContain("Deleted profile 'temp'");
  });

  it("delete refuses to remove the active profile", async () => {
    await run("profile", "create", "keep");
    await run("profile", "switch", "keep");
    await run("profile", "delete", "keep");

    expect(errors.join("\n")).toMatch(/active/i);
    expect(fs.existsSync(path.join(tmpHome, "profiles", "keep"))).toBe(true);
  });

  it("create --clone copies .env from the source profile", async () => {
    await run("profile", "create", "src");
    fs.writeFileSync(
      path.join(tmpHome, "profiles", "src", ".env"),
      "API_KEY=secret\n",
      "utf-8",
    );

    await run("profile", "create", "copy", "--clone", "src");

    const clonedEnv = path.join(tmpHome, "profiles", "copy", ".env");
    expect(fs.existsSync(clonedEnv)).toBe(true);
    expect(fs.readFileSync(clonedEnv, "utf-8")).toContain("API_KEY=secret");
  });
});
