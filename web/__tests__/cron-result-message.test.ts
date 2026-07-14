/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { addCronResultMessage } from "../js/messages.js";

describe("addCronResultMessage", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="chatMessages"></div>`;
  });

  it("renders a distinct cron-result bubble with job name, time, and rendered output", () => {
    const id = addCronResultMessage(
      "nightly-report",
      "2026-07-13T10:00:00Z",
      "**Build** succeeded",
      true,
    );

    const el = document.getElementById(id) as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.className).toContain("message");
    expect(el.className).toContain("assistant");
    expect(el.className).toContain("cron-result-message");

    const badge = el.querySelector(".cron-result-badge");
    expect(badge).toBeTruthy();
    expect(badge!.querySelector(".cron-result-name")?.textContent).toBe(
      "nightly-report",
    );
    expect(badge!.querySelector(".cron-result-icon")?.className).toContain(
      "success",
    );

    // Output goes through renderMarkdown, not raw innerHTML assignment of
    // attacker/job-controlled text — markdown constructs should render.
    const content = el.querySelector(".message-content");
    expect(content?.innerHTML).toContain("<strong>Build</strong>");
  });

  it("marks the badge as failed when success is explicitly false", () => {
    const id = addCronResultMessage("flaky-job", null, "oops", false);
    const el = document.getElementById(id) as HTMLElement;
    expect(el.querySelector(".cron-result-icon")?.className).toContain("failed");
  });

  it("treats a missing/undefined success flag as success (not failed)", () => {
    const id = addCronResultMessage("job", null, "ok", undefined);
    const el = document.getElementById(id) as HTMLElement;
    expect(el.querySelector(".cron-result-icon")?.className).toContain("success");
  });

  it("escapes an attacker-controlled job name instead of injecting real markup", () => {
    const id = addCronResultMessage(
      '<img src=x onerror=alert(1)>',
      "2026-07-13T10:00:00Z",
      "output",
      true,
    );
    const el = document.getElementById(id) as HTMLElement;
    const badge = el.querySelector(".cron-result-badge")!;

    // No live <img> element should exist inside the badge — the payload
    // must be inert, escaped text.
    expect(badge.querySelector("img")).toBeNull();
    expect(badge.querySelector(".cron-result-name")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("sanitizes script injection attempts in the cron output through renderMarkdown", () => {
    const id = addCronResultMessage(
      "job",
      null,
      "<script>alert(document.cookie)</script>",
      true,
    );
    const el = document.getElementById(id) as HTMLElement;
    const content = el.querySelector(".message-content")!;
    expect(content.querySelector("script")).toBeNull();
    expect(content.innerHTML).toContain("&lt;script&gt;");
  });

  it("rejects javascript: links embedded in the cron output", () => {
    const id = addCronResultMessage(
      "job",
      null,
      "[click me](javascript:alert(1))",
      true,
    );
    const el = document.getElementById(id) as HTMLElement;
    const content = el.querySelector(".message-content")!;
    expect(content.innerHTML).not.toContain('href="javascript:');
    expect(content.innerHTML).toContain('href="#"');
  });

  it("omits the name/time spans entirely when not provided, rather than rendering empty markup", () => {
    const id = addCronResultMessage(undefined, undefined, "output", true);
    const el = document.getElementById(id) as HTMLElement;
    const badge = el.querySelector(".cron-result-badge")!;
    expect(badge.querySelector(".cron-result-name")).toBeNull();
    expect(badge.querySelector(".cron-result-time")).toBeNull();
  });

  it("appends into #chatMessages and returns a cron-prefixed id", () => {
    const messagesDiv = document.getElementById("chatMessages")!;
    const id = addCronResultMessage("job", null, "output", true);
    expect(id.startsWith("cron-")).toBe(true);
    expect(messagesDiv.contains(document.getElementById(id))).toBe(true);
  });
});
