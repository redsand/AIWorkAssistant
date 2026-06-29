import { describe, expect, it } from "vitest";

import { splitLabelString } from "../autonomous-loop";

describe("splitLabelString", () => {
  it("returns a single-element array for one label", () => {
    expect(splitLabelString("ready-for-agent")).toEqual(["ready-for-agent"]);
  });

  it("splits and trims comma-space joined labels (the runner form's shape)", () => {
    expect(splitLabelString("ready-for-agent, octorepl")).toEqual([
      "ready-for-agent",
      "octorepl",
    ]);
  });

  it("handles tight commas without spaces", () => {
    expect(splitLabelString("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("drops empty fragments from trailing commas or doubles", () => {
    expect(splitLabelString("a,,b,")).toEqual(["a", "b"]);
  });

  it("returns an empty array when given only whitespace/commas", () => {
    expect(splitLabelString("  ,  ,  ")).toEqual([]);
    expect(splitLabelString("")).toEqual([]);
  });
});
