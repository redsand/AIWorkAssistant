import { describe, it, expect, vi } from "vitest";
import { ClaimKitAdapter } from "../claimkit-adapter";

function makeRedisClient(keys: string[]) {
  return {
    get: vi.fn(async (_k: string) => null),
    set: vi.fn(async (_k: string, _v: string) => {}),
    scan: vi.fn(async (_c: number, _options: { MATCH: string; COUNT: number }) => {
      // Return all keys in one page for determinism.
      return { cursor: 0, keys };
    }),
    unlink: vi.fn(async (toRemove: string[]) => {
      for (const k of toRemove) {
        const i = keys.indexOf(k);
        if (i !== -1) keys.splice(i, 1);
      }
      return toRemove.length;
    }),
  };
}

describe("ClaimKitAdapter.repairStaleKeys", () => {
  it("uses SCAN + UNLINK and updates the dimension and mode meta keys", async () => {
    const keys = ["prefix:a", "prefix:b", "prefix:c"];
    const rc = makeRedisClient(keys);
    const adapter = new ClaimKitAdapter();

    await (adapter as any).repairStaleKeys(
      rc,
      "prefix:meta:dim",
      "prefix:meta:mode",
      "prefix",
      1536,
      "bruteForce",
    );

    expect(rc.scan).toHaveBeenCalledWith(0, { MATCH: "prefix:*", COUNT: 100 });
    expect(rc.unlink).toHaveBeenCalledWith(keys);
    expect(rc.set).toHaveBeenCalledWith("prefix:meta:dim", "1536");
    expect(rc.set).toHaveBeenCalledWith("prefix:meta:mode", "bruteForce");
  });

  it("iterates through multiple SCAN pages", async () => {
    const pages = [
      { cursor: 1, keys: ["prefix:a", "prefix:b"] },
      { cursor: 0, keys: ["prefix:c", "prefix:d"] },
    ];
    const rc = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      scan: vi.fn(async (_c: number, _opts: any) => {
        const page = pages.shift();
        return page ?? { cursor: 0, keys: [] };
      }),
      unlink: vi.fn(async () => 0),
    };
    const adapter = new ClaimKitAdapter();

    await (adapter as any).repairStaleKeys(
      rc,
      "prefix:meta:dim",
      "prefix:meta:mode",
      "prefix",
      768,
      "redisSearch",
    );

    expect(rc.scan).toHaveBeenCalledTimes(2);
    expect(rc.unlink).toHaveBeenNthCalledWith(1, ["prefix:a", "prefix:b"]);
    expect(rc.unlink).toHaveBeenNthCalledWith(2, ["prefix:c", "prefix:d"]);
    expect(rc.set).toHaveBeenCalledWith("prefix:meta:dim", "768");
    expect(rc.set).toHaveBeenCalledWith("prefix:meta:mode", "redisSearch");
  });
});
