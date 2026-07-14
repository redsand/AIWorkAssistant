import { describe, expect, it } from "vitest";

import {
  formatRuntimePackageMetadata,
  getInstalledPackageRuntimeMetadata,
  type RuntimePackageMetadata,
} from "../runtime-metadata";

describe("runtime metadata", () => {
  it("formats package identity with git commit, branch, dirty state, and paths", () => {
    const metadata: RuntimePackageMetadata = {
      name: "@redsand/claimkit",
      version: "0.2.1",
      packageRoot: "C:\\repo\\claimkit",
      git: {
        repoRoot: "C:\\repo\\claimkit",
        commit: "abc123def456",
        branch: "main",
        dirty: true,
      },
    };

    expect(formatRuntimePackageMetadata("ClaimKit", metadata)).toBe(
      "[Runtime] ClaimKit: @redsand/claimkit@0.2.1 commit=abc123def456 branch=main dirty=true packageRoot=C:\\repo\\claimkit repoRoot=C:\\repo\\claimkit",
    );
  });

  it("reports unresolved packages without throwing", () => {
    const metadata = getInstalledPackageRuntimeMetadata("@redsand/package-that-does-not-exist");

    expect(metadata).toMatchObject({
      name: "@redsand/package-that-does-not-exist",
      version: "unresolved",
      packageRoot: null,
      git: {
        repoRoot: null,
        commit: null,
        branch: null,
        dirty: null,
      },
    });
    expect(formatRuntimePackageMetadata("Missing", metadata)).toContain(
      "commit=unavailable branch=unavailable dirty=unknown packageRoot=unresolved repoRoot=unavailable",
    );
  });
});
