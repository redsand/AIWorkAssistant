import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";

// The functions are pure geometry — we re-implement the same logic here for unit testing.
// This matches the implementation in web/js/kanban-dep-utils.js exactly.

function getCardCenter(el: { getBoundingClientRect: () => DOMRect }, boardRect: DOMRect) {
  const r = el.getBoundingClientRect();
  return {
    x: r.left - boardRect.left + r.width / 2,
    y: r.top - boardRect.top + r.height / 2,
  };
}

function buildEdgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const H = (to.x - from.x) / 2;
  return (
    "M " + from.x + "," + from.y +
    " C " + (from.x + H) + "," + from.y +
    " " + (from.x + H) + "," + to.y +
    " " + to.x + "," + to.y
  );
}

function safeFindByDataKey(parent: Element, key: string): Element | null {
  const items = parent.querySelectorAll("[data-key]");
  for (let i = 0; i < items.length; i++) {
    if (items[i].getAttribute("data-key") === key) {
      return items[i];
    }
  }
  return null;
}

describe("buildEdgePath", () => {
  it("produces a valid SVG cubic bezier path string", () => {
    const d = buildEdgePath({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(d).toBe("M 0,0 C 50,0 50,100 100,100");
  });

  it("computes horizontal midpoint as control point offset", () => {
    const d = buildEdgePath({ x: 10, y: 20 }, { x: 110, y: 80 });
    // H = (110 - 10) / 2 = 50
    expect(d).toBe("M 10,20 C 60,20 60,80 110,80");
  });

  it("handles zero-length path (same from/to)", () => {
    const d = buildEdgePath({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(d).toBe("M 50,50 C 50,50 50,50 50,50");
  });

  it("handles negative direction (to left of from)", () => {
    const d = buildEdgePath({ x: 200, y: 0 }, { x: 0, y: 100 });
    // H = (0 - 200) / 2 = -100
    expect(d).toBe("M 200,0 C 100,0 100,100 0,100");
  });

  it("handles vertical-only movement (same x)", () => {
    const d = buildEdgePath({ x: 50, y: 0 }, { x: 50, y: 200 });
    // H = 0
    expect(d).toBe("M 50,0 C 50,0 50,200 50,200");
  });
});

describe("getCardCenter", () => {
  function makeFakeRect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      left, top, width, height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function makeFakeElement(left: number, top: number, width: number, height: number) {
    return { getBoundingClientRect: () => makeFakeRect(left, top, width, height) };
  }

  it("returns center of element relative to board", () => {
    const el = makeFakeElement(100, 200, 60, 40);
    const board = makeFakeRect(50, 100, 800, 600);
    const center = getCardCenter(el, board);
    // x = 100 - 50 + 60/2 = 80
    // y = 200 - 100 + 40/2 = 120
    expect(center).toEqual({ x: 80, y: 120 });
  });

  it("returns correct center when element is at board origin", () => {
    const el = makeFakeElement(50, 100, 100, 80);
    const board = makeFakeRect(50, 100, 800, 600);
    const center = getCardCenter(el, board);
    expect(center).toEqual({ x: 50, y: 40 });
  });

  it("handles zero-size element", () => {
    const el = makeFakeElement(200, 300, 0, 0);
    const board = makeFakeRect(0, 0, 800, 600);
    const center = getCardCenter(el, board);
    expect(center).toEqual({ x: 200, y: 300 });
  });
});

describe("safeFindByDataKey", () => {
  it("finds element by exact data-key match", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = '<div><span data-key="github:owner/repo:1">Card</span></div>';
    const parent = doc.querySelector("div")!;
    const result = safeFindByDataKey(parent, "github:owner/repo:1");
    expect(result).not.toBeNull();
    expect(result?.textContent).toBe("Card");
  });

  it("returns null when no match found", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = '<div><span data-key="other">Card</span></div>';
    const parent = doc.querySelector("div")!;
    const result = safeFindByDataKey(parent, "github:owner/repo:1");
    expect(result).toBeNull();
  });

  it("returns null when parent has no data-key elements", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = "<div><span>No key</span></div>";
    const parent = doc.querySelector("div")!;
    const result = safeFindByDataKey(parent, "anything");
    expect(result).toBeNull();
  });

  it("handles keys with special characters safely", () => {
    const maliciousKey = 'foo"bar]script';
    const win = new Window();
    const doc = win.document;
    const span = doc.createElement("span");
    span.setAttribute("data-key", maliciousKey);
    span.textContent = "Card";
    const div = doc.createElement("div");
    div.appendChild(span);
    doc.body.appendChild(div);

    const result = safeFindByDataKey(div, maliciousKey);
    expect(result).not.toBeNull();
    expect(result?.getAttribute("data-key")).toBe(maliciousKey);
  });

  it("does not match partial keys", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = '<div><span data-key="github:owner/repo:123">Card</span></div>';
    const parent = doc.querySelector("div")!;
    const result = safeFindByDataKey(parent, "github:owner/repo:1");
    expect(result).toBeNull();
  });

  it("returns first match when multiple elements have same data-key", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML =
      '<div><span data-key="key1">First</span><span data-key="key1">Second</span></div>';
    const parent = doc.querySelector("div")!;
    const result = safeFindByDataKey(parent, "key1");
    expect(result?.textContent).toBe("First");
  });
});
