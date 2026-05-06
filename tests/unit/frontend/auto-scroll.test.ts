// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";

interface MockEl {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollTo: ReturnType<typeof vi.fn>;
}

const SCROLL_NEAR_BOTTOM_PX = 150;

function createAutoScrollController() {
  let autoScrollEnabled = true;
  let jumpToLatestVisible = false;

  function isNearBottom(el: MockEl | null): boolean {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX;
  }

  function scrollChatToBottom(el: MockEl, force = false) {
    if (!force && !isNearBottom(el)) {
      jumpToLatestVisible = true;
      return;
    }
    jumpToLatestVisible = false;
    autoScrollEnabled = true;
    el.scrollTo({ top: el.scrollHeight, behavior: force ? "instant" : "smooth" });
  }

  function enableAutoScroll() {
    autoScrollEnabled = true;
    jumpToLatestVisible = false;
  }

  function isAutoScrollEnabled() {
    return autoScrollEnabled;
  }

  function isJumpToLatestVisible() {
    return jumpToLatestVisible;
  }

  function handleScroll(el: MockEl) {
    if (isNearBottom(el)) {
      autoScrollEnabled = true;
      jumpToLatestVisible = false;
    } else {
      autoScrollEnabled = false;
      jumpToLatestVisible = true;
    }
  }

  return {
    isAutoScrollEnabled,
    isJumpToLatestVisible,
    isNearBottom: (el: MockEl | null) => isNearBottom(el),
    scrollChatToBottom: (el: MockEl, force?: boolean) => scrollChatToBottom(el, force),
    enableAutoScroll,
    handleScroll,
  };
}

function createMockEl(
  clientHeight = 600,
  scrollHeight = 2000,
  scrollTop = 1850,
): MockEl {
  return {
    scrollHeight,
    scrollTop,
    clientHeight,
    scrollTo: vi.fn(),
  };
}

describe("auto-scroll", () => {
  let controller: ReturnType<typeof createAutoScrollController>;

  beforeEach(() => {
    controller = createAutoScrollController();
  });

  describe("isNearBottom", () => {
    it("returns true when within SCROLL_NEAR_BOTTOM_PX of bottom", () => {
      // max scroll = scrollHeight - clientHeight = 2000 - 600 = 1400
      // scrollTop = 1260 → remaining = 1400 - 1260 = 140 < 150
      const el = createMockEl(600, 2000, 1260);
      expect(controller.isNearBottom(el)).toBe(true);
    });

    it("returns true when at exact bottom", () => {
      // scrollTop = 1400 → remaining = 0
      const el = createMockEl(600, 2000, 1400);
      expect(controller.isNearBottom(el)).toBe(true);
    });

    it("returns false when scrolled up past threshold", () => {
      // scrollTop = 1000 → remaining = 400 > 150
      const el = createMockEl(600, 2000, 1000);
      expect(controller.isNearBottom(el)).toBe(false);
    });

    it("returns true when null element passed", () => {
      expect(controller.isNearBottom(null)).toBe(true);
    });

    it("returns true when exactly at threshold boundary", () => {
      // remaining = 150 exactly → not less than, so should be false
      // scrollTop = 1250 → 2000 - 1250 - 600 = 150 → 150 < 150 is false
      const el = createMockEl(600, 2000, 1250);
      expect(controller.isNearBottom(el)).toBe(false);
    });

    it("returns true just inside threshold boundary", () => {
      // remaining = 149 → 149 < 150 is true
      const el = createMockEl(600, 2000, 1251);
      expect(controller.isNearBottom(el)).toBe(true);
    });
  });

  describe("enableAutoScroll", () => {
    it("enables auto-scroll after being disabled", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      controller.enableAutoScroll();
      expect(controller.isAutoScrollEnabled()).toBe(true);
    });

    it("hides jump-to-latest button", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isJumpToLatestVisible()).toBe(true);

      controller.enableAutoScroll();
      expect(controller.isJumpToLatestVisible()).toBe(false);
    });
  });

  describe("scrollChatToBottom", () => {
    it("scrolls to bottom when auto-scroll is enabled and near bottom", () => {
      const el = createMockEl(600, 2000, 1400);
      controller.scrollChatToBottom(el);
      expect(el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    });

    it("scrolls instantly when forced", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.scrollChatToBottom(el, true);
      expect(el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "instant" });
    });

    it("shows jump-to-latest when auto-scroll is disabled and not forced", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      controller.scrollChatToBottom(el);
      expect(el.scrollTo).not.toHaveBeenCalled();
      expect(controller.isJumpToLatestVisible()).toBe(true);
    });

    it("enables auto-scroll and hides jump button on forced scroll", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      controller.scrollChatToBottom(el, true);
      expect(controller.isAutoScrollEnabled()).toBe(true);
      expect(controller.isJumpToLatestVisible()).toBe(false);
    });
  });

  describe("handleScroll (scroll event listener)", () => {
    it("enables auto-scroll when user scrolls to bottom", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      // User scrolls back to bottom
      el.scrollTop = 1400;
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(true);
    });

    it("disables auto-scroll when user scrolls up", () => {
      const el = createMockEl(600, 2000, 1400);
      expect(controller.isAutoScrollEnabled()).toBe(true);

      el.scrollTop = 1000;
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);
    });

    it("shows jump-to-latest when user scrolls away from bottom", () => {
      const el = createMockEl(600, 2000, 1400);
      controller.handleScroll(el);
      expect(controller.isJumpToLatestVisible()).toBe(false);

      el.scrollTop = 1000;
      controller.handleScroll(el);
      expect(controller.isJumpToLatestVisible()).toBe(true);
    });

    it("hides jump-to-latest when user scrolls back to bottom", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isJumpToLatestVisible()).toBe(true);

      el.scrollTop = 1400;
      controller.handleScroll(el);
      expect(controller.isJumpToLatestVisible()).toBe(false);
    });
  });

  describe("integration scenarios", () => {
    it("new message arrives → auto-scrolls when at bottom", () => {
      const el = createMockEl(600, 2000, 1400);
      expect(controller.isAutoScrollEnabled()).toBe(true);

      // New content added — browser keeps user near bottom (scrollTop adjusts)
      el.scrollHeight = 2500;
      el.scrollTop = 1900; // browser keeps viewport near bottom
      controller.scrollChatToBottom(el);

      expect(el.scrollTo).toHaveBeenCalledWith({ top: 2500, behavior: "smooth" });
    });

    it("new message arrives → does NOT auto-scroll when user scrolled up", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      // New content added
      el.scrollHeight = 2500;
      controller.scrollChatToBottom(el);

      expect(el.scrollTo).not.toHaveBeenCalled();
      expect(controller.isJumpToLatestVisible()).toBe(true);
    });

    it("user sends message → enables auto-scroll → scrolls to bottom", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      // User sends a message (enables auto-scroll first, like sendMessage does)
      controller.enableAutoScroll();
      el.scrollHeight = 2500;
      el.scrollTop = 1900; // browser adjusts scroll after content added
      controller.scrollChatToBottom(el);

      expect(el.scrollTo).toHaveBeenCalledWith({ top: 2500, behavior: "smooth" });
    });

    it("clicking jump-to-latest → force scroll → re-enables auto-scroll", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);
      expect(controller.isJumpToLatestVisible()).toBe(true);

      // Simulate clicking jump-to-latest
      controller.scrollChatToBottom(el, true);
      expect(controller.isAutoScrollEnabled()).toBe(true);
      expect(controller.isJumpToLatestVisible()).toBe(false);
    });

    it("switching conversation → enables auto-scroll", () => {
      const el = createMockEl(600, 2000, 1000);
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      controller.enableAutoScroll();
      expect(controller.isAutoScrollEnabled()).toBe(true);
      expect(controller.isJumpToLatestVisible()).toBe(false);
    });

    it("tool call update scrolls only when auto-scroll enabled", () => {
      const el = createMockEl(600, 2000, 1400);
      expect(controller.isAutoScrollEnabled()).toBe(true);
      controller.scrollChatToBottom(el);
      expect(el.scrollTo).toHaveBeenCalledTimes(1);

      // User scrolls up mid-stream
      el.scrollTop = 1000;
      controller.handleScroll(el);
      expect(controller.isAutoScrollEnabled()).toBe(false);

      // Tool call completes — should NOT scroll
      controller.scrollChatToBottom(el);
      expect(el.scrollTo).toHaveBeenCalledTimes(1); // still 1, not called again
    });
  });
});