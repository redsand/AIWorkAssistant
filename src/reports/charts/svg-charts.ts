/**
 * Pure-SVG chart rendering. No native deps. SVG embeds natively in DOCX, PDF,
 * HTML, and Markdown (as data: URLs or external files). The output is deliberately
 * minimal and readable — no gradients, no fancy fonts — so it survives editing
 * in Word and converts cleanly when a customer copies the doc to PowerPoint.
 */

import type {
  BarChartData,
  PieChartData,
  ReportChart,
  TimelineChartData,
} from "../types";

const DEFAULT_W = 720;
const DEFAULT_H = 360;
const PALETTE = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#ea580c", // orange
  "#7c3aed", // purple
  "#0891b2", // cyan
  "#ca8a04", // amber
  "#9333ea", // violet
];

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  }[c] as string));
}

function seriesColor(idx: number): string {
  return PALETTE[idx % PALETTE.length];
}

export function renderChart(chart: ReportChart): string {
  switch (chart.kind) {
    case "timeline": return renderTimeline(chart);
    case "bar":      return renderBar(chart);
    case "pie":      return renderPie(chart);
    default: throw new Error(`Unknown chart kind: ${(chart as { kind?: string }).kind}`);
  }
}

function svgHeader(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Inter, Arial, sans-serif" font-size="12">`;
}

function captionText(text: string | undefined, width: number, height: number): string {
  if (!text) return "";
  return `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#475569">${esc(text)}</text>`;
}

// ── Timeline ────────────────────────────────────────────────────────────────
function renderTimeline(chart: ReportChart): string {
  const data = chart.data as TimelineChartData;
  const width = chart.width ?? DEFAULT_W;
  const height = chart.height ?? DEFAULT_H;
  const events = [...data.events].sort((a, b) => (a.at < b.at ? -1 : 1));
  if (events.length === 0) {
    return svgHeader(width, height) + "<text x='10' y='20' fill='#94a3b8'>No events.</text></svg>";
  }
  const startsAt = data.startsAt ?? events[0].at;
  const endsAt = data.endsAt ?? events[events.length - 1].at;
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const span = Math.max(end - start, 1);
  const padding = { left: 70, right: 40, top: 60, bottom: 60 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const axisY = padding.top + plotH / 2;

  const series = [...new Set(events.map((e) => e.series ?? "default"))];
  const seriesIdx = new Map(series.map((s, i) => [s, i] as const));

  // Tick marks — show start, end, and 3 mid-points.
  const tickCount = 5;
  const ticks: Array<{ x: number; t: string }> = [];
  for (let i = 0; i < tickCount; i++) {
    const t = start + (span * i) / (tickCount - 1);
    const x = padding.left + (plotW * i) / (tickCount - 1);
    const iso = new Date(t).toISOString();
    ticks.push({ x, t: iso.slice(11, 16) + "Z" });
  }

  const eventNodes = events.map((e, i) => {
    const t = new Date(e.at).getTime();
    const x = padding.left + (plotW * (t - start)) / span;
    const sIdx = seriesIdx.get(e.series ?? "default") ?? 0;
    const color = seriesColor(sIdx);
    // Alternate label above/below the axis so dense events don't collide.
    const above = i % 2 === 0;
    const labelY = above ? axisY - 18 : axisY + 30;
    const labelAnchor = "middle";
    const truncated = e.label.length > 32 ? e.label.slice(0, 30) + "…" : e.label;
    return [
      `<line x1="${x}" y1="${axisY - 4}" x2="${x}" y2="${axisY + 4}" stroke="${color}" stroke-width="2"/>`,
      `<circle cx="${x}" cy="${axisY}" r="4" fill="${color}"/>`,
      `<text x="${x}" y="${labelY}" text-anchor="${labelAnchor}" fill="#1e293b" font-size="11">${esc(truncated)}</text>`,
    ].join("");
  }).join("");

  // Legend (only if >1 series)
  let legend = "";
  if (series.length > 1) {
    legend = series.map((s, i) => {
      const x = padding.left + i * 110;
      const color = seriesColor(i);
      return `<rect x="${x}" y="20" width="10" height="10" fill="${color}"/><text x="${x + 16}" y="29" fill="#334155">${esc(s)}</text>`;
    }).join("");
  }

  const tickNodes = ticks.map((t) =>
    `<line x1="${t.x}" y1="${axisY + 6}" x2="${t.x}" y2="${axisY + 10}" stroke="#64748b"/>` +
    `<text x="${t.x}" y="${axisY + 22}" text-anchor="middle" fill="#64748b" font-size="10">${esc(t.t)}</text>`,
  ).join("");

  return [
    svgHeader(width, height),
    `<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>`,
    legend,
    `<line x1="${padding.left}" y1="${axisY}" x2="${width - padding.right}" y2="${axisY}" stroke="#cbd5e1" stroke-width="1.5"/>`,
    tickNodes,
    eventNodes,
    captionText(chart.caption, width, height),
    "</svg>",
  ].join("");
}

// ── Bar chart ───────────────────────────────────────────────────────────────
function renderBar(chart: ReportChart): string {
  const data = chart.data as BarChartData;
  const width = chart.width ?? DEFAULT_W;
  const height = chart.height ?? DEFAULT_H;
  const padding = { left: 70, right: 30, top: 40, bottom: 80 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const bars = data.bars;
  if (bars.length === 0) {
    return svgHeader(width, height) + "<text x='10' y='20' fill='#94a3b8'>No data.</text></svg>";
  }
  const maxV = Math.max(...bars.map((b) => b.value), 1);
  const barW = plotW / bars.length * 0.7;
  const gap = plotW / bars.length * 0.3;

  const series = [...new Set(bars.map((b) => b.series ?? "default"))];
  const seriesIdx = new Map(series.map((s, i) => [s, i] as const));

  const barNodes = bars.map((b, i) => {
    const x = padding.left + i * (barW + gap) + gap / 2;
    const h = (b.value / maxV) * plotH;
    const y = padding.top + plotH - h;
    const color = seriesColor(seriesIdx.get(b.series ?? "default") ?? 0);
    return [
      `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" />`,
      `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" fill="#1e293b" font-size="10">${esc(String(b.value))}</text>`,
      `<text x="${x + barW / 2}" y="${padding.top + plotH + 14}" text-anchor="middle" fill="#475569" font-size="10" transform="rotate(-20 ${x + barW / 2} ${padding.top + plotH + 14})">${esc(b.label)}</text>`,
    ].join("");
  }).join("");

  // y-axis with 5 grid lines
  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + plotH - (plotH * i) / 4;
    const v = Math.round((maxV * i) / 4);
    yTicks.push(
      `<line x1="${padding.left}" y1="${y}" x2="${padding.left + plotW}" y2="${y}" stroke="#e2e8f0"/>` +
        `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${v}</text>`,
    );
  }

  const yLabel = data.yLabel
    ? `<text x="14" y="${padding.top + plotH / 2}" text-anchor="middle" font-size="11" fill="#475569" transform="rotate(-90 14 ${padding.top + plotH / 2})">${esc(data.yLabel)}</text>`
    : "";

  return [
    svgHeader(width, height),
    `<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>`,
    yTicks.join(""),
    barNodes,
    yLabel,
    captionText(chart.caption, width, height),
    "</svg>",
  ].join("");
}

// ── Pie chart ───────────────────────────────────────────────────────────────
function renderPie(chart: ReportChart): string {
  const data = chart.data as PieChartData;
  const width = chart.width ?? DEFAULT_W;
  const height = chart.height ?? DEFAULT_H;
  const cx = width / 3;
  const cy = height / 2;
  const r = Math.min(cx, cy) * 0.8;
  const slices = data.slices;
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) {
    return svgHeader(width, height) + "<text x='10' y='20' fill='#94a3b8'>No data.</text></svg>";
  }
  let acc = 0;
  const sliceNodes = slices.map((s, i) => {
    const startA = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += Math.max(0, s.value);
    const endA = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + r * Math.cos(startA);
    const y1 = cy + r * Math.sin(startA);
    const x2 = cx + r * Math.cos(endA);
    const y2 = cy + r * Math.sin(endA);
    const large = endA - startA > Math.PI ? 1 : 0;
    const color = seriesColor(i);
    return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${color}"/>`;
  }).join("");

  // Legend right of the pie
  const legendX = cx * 2 + 10;
  const legendNodes = slices.map((s, i) => {
    const y = 40 + i * 22;
    const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
    const color = seriesColor(i);
    return `<rect x="${legendX}" y="${y - 10}" width="12" height="12" fill="${color}"/>` +
      `<text x="${legendX + 18}" y="${y}" fill="#1e293b">${esc(s.label)} — ${s.value} (${pct}%)</text>`;
  }).join("");

  return [
    svgHeader(width, height),
    `<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>`,
    sliceNodes,
    legendNodes,
    captionText(chart.caption, width, height),
    "</svg>",
  ].join("");
}
