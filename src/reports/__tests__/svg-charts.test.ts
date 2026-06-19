import { describe, expect, it } from "vitest";
import { renderChart } from "../charts/svg-charts";

describe("svg-charts", () => {
  it("renderChart(timeline) produces valid SVG with one node per event", () => {
    const svg = renderChart({
      kind: "timeline",
      caption: "Timeline of events",
      data: {
        events: [
          { at: "2026-06-17T15:20:09Z", label: "Test send" },
          { at: "2026-06-17T15:38:20Z", label: "Mass phishing" },
          { at: "2026-06-17T15:52:01Z", label: "Account disabled" },
        ],
      },
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // One circle (event marker) per event
    expect((svg.match(/<circle /g) || []).length).toBe(3);
    expect(svg).toContain("Test send");
    expect(svg).toContain("Timeline of events");
  });

  it("renderChart(bar) renders one rect per bar", () => {
    const svg = renderChart({
      kind: "bar",
      caption: "Hits per IP",
      data: {
        yLabel: "Events",
        bars: [
          { label: "Charter IPv6", value: 709 },
          { label: "Zscaler 165", value: 232 },
          { label: "T-Mobile", value: 139 },
        ],
      },
    });
    // 3 bars + 5 y-tick lines + 1 background rect = check ≥ 4 rects
    expect((svg.match(/<rect /g) || []).length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain("Hits per IP");
  });

  it("renderChart(pie) renders one path per slice with legend", () => {
    const svg = renderChart({
      kind: "pie",
      caption: "By ASN",
      data: {
        slices: [
          { label: "Zscaler", value: 60 },
          { label: "Charter", value: 30 },
          { label: "T-Mobile", value: 10 },
        ],
      },
    });
    expect((svg.match(/<path /g) || []).length).toBe(3);
    expect(svg).toContain("Zscaler");
    expect(svg).toContain("By ASN");
  });

  it("empty timeline data still produces valid SVG", () => {
    const svg = renderChart({ kind: "timeline", data: { events: [] } });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("No events");
  });

  it("HTML special chars in labels are escaped", () => {
    const svg = renderChart({
      kind: "bar",
      data: {
        bars: [
          { label: "<script>alert(1)</script>", value: 5 },
        ],
      },
    });
    expect(svg).not.toContain("<script>alert");
    expect(svg).toContain("&lt;script&gt;alert");
  });
});
