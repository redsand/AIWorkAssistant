import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Prevent dotenv from loading a real .env file during tests.
vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

describe("resolvePath profile routing", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  let resolvePath: (typeof import("../../../src/config/env"))["resolvePath"];

  const profilesDir = () => path.join(tmpHome, "profiles");
  const activeFile = () => path.join(profilesDir(), "active");

  beforeEach(async () => {
    savedHome = process.env.HERMES_HOME;
    savedProfile = process.env.ACTIVE_PROFILE;

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-path-"));
    fs.mkdirSync(profilesDir(), { recursive: true });

    process.env.HERMES_HOME = tmpHome;
    delete process.env.ACTIVE_PROFILE;

    vi.resetModules();
    resolvePath = (await import("../../../src/config/env")).resolvePath;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.ACTIVE_PROFILE;
    else process.env.ACTIVE_PROFILE = savedProfile;

    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("routes to the default profile when nothing is configured", () => {
    expect(resolvePath("memories")).toBe(
      path.join(tmpHome, "profiles", "default", "memories"),
    );
  });

  it("honors process.env.ACTIVE_PROFILE", () => {
    process.env.ACTIVE_PROFILE = "work";
    expect(resolvePath("skills")).toBe(
      path.join(tmpHome, "profiles", "work", "skills"),
    );
  });

  it("falls back to the active marker file when ACTIVE_PROFILE is unset", () => {
    fs.writeFileSync(activeFile(), "client-acme\n", "utf-8");
    expect(resolvePath("sessions")).toBe(
      path.join(tmpHome, "profiles", "client-acme", "sessions"),
    );
  });

  it("prefers process.env.ACTIVE_PROFILE over the marker file", () => {
    fs.writeFileSync(activeFile(), "client-acme\n", "utf-8");
    process.env.ACTIVE_PROFILE = "work";
    expect(resolvePath("memories")).toBe(
      path.join(tmpHome, "profiles", "work", "memories"),
    );
  });

  it("ignores an empty marker file and uses the default profile", () => {
    fs.writeFileSync(activeFile(), "   \n", "utf-8");
    expect(resolvePath("memories")).toBe(
      path.join(tmpHome, "profiles", "default", "memories"),
    );
  });
});
