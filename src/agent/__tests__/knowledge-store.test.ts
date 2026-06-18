// Verifies knowledge-store splits oversized entries into heading-aware
// sub-chunks that reference the parent via parent_id (issue #228).
import { describe, it, expect, afterEach } from "vitest";
import { knowledgeStore } from "../knowledge-store";
import { env } from "../../config/env";

const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    // Remove the parent and any sub-chunks it spawned.
    for (const e of knowledgeStore.getAllEntries()) {
      if (e.id === id || e.parentId === id) knowledgeStore.deleteEntry(e.id);
    }
  }
});

// Builds markdown content guaranteed to exceed 2x the configured chunk size.
function bigMarkdown(): string {
  const para = "This is filler content for a documentation section. ".repeat(20);
  const targetChars = env.RAG_CHUNK_SIZE * 1.8 * 3; // ~3x chunk size in chars
  const sections: string[] = [];
  let i = 0;
  let total = 0;
  while (total < targetChars) {
    const section = `## Section ${i}\n${para}\n`;
    sections.push(section);
    total += section.length;
    i++;
  }
  return `# Document Title\n${sections.join("\n")}`;
}

describe("knowledgeStore.store — oversized entry chunking", () => {
  it("splits a large entry into parent-referencing sub-chunks", () => {
    const id = knowledgeStore.store({
      source: "web_page",
      title: "Large Doc",
      content: bigMarkdown(),
      tags: ["docs"],
      createdAt: new Date(),
    });
    createdIds.push(id);

    const children = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === id);

    expect(children.length).toBeGreaterThan(1);
    // Sub-chunks inherit the parent title with a part suffix.
    expect(children.every((c) => c.title.startsWith("Large Doc (part "))).toBe(true);
    // At least one sub-chunk carries a heading breadcrumb context header.
    expect(children.some((c) => c.content.includes("Section"))).toBe(true);
  });

  it("does not split a small entry", () => {
    const id = knowledgeStore.store({
      source: "manual",
      title: "Tiny Note",
      content: "Just a short note with no need for chunking.",
      tags: [],
      createdAt: new Date(),
    });
    createdIds.push(id);

    const children = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === id);
    expect(children.length).toBe(0);
  });
});
