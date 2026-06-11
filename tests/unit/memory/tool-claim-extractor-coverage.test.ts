import { afterEach, describe, expect, it, vi } from "vitest";

const currentClaims = new Map<string, Array<{ attribute?: string; value?: string }>>();

const mockEntityMemory = {
  upsertEntity: vi.fn((input: { type: string; name: string }) => ({
    id: `${input.type}:${input.name}`,
  })),
  getCurrentClaims: vi.fn((entityId: string) => currentClaims.get(entityId) ?? []),
  setStructuredFact: vi.fn((entityId: string, attribute: string, value: string) => {
    const claims = currentClaims.get(entityId) ?? [];
    const withoutAttribute = claims.filter((claim) => claim.attribute !== attribute);
    currentClaims.set(entityId, [{ attribute, value }, ...withoutAttribute]);
  }),
};

async function loadExtractor() {
  vi.resetModules();
  vi.doMock("../../../src/memory/entity-memory", () => ({
    entityMemory: mockEntityMemory,
  }));
  return import("../../../src/memory/tool-claim-extractor");
}

describe("tool-claim-extractor coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    currentClaims.clear();
  });

  it("extracts claims from singular integration payloads", async () => {
    const { ingestStructuredClaims } = await loadExtractor();
    const cases: Array<[string, unknown]> = [
      [
        "jira.update_issue",
        {
          data: {
            key: "IR-82",
            self: "https://jira.example/IR-82",
            fields: {
              summary: "Ship graph retrieval",
              status: { name: "Done" },
              priority: { key: "High" },
              assignee: { displayName: "Tim" },
              reporter: { value: "QA" },
              issuetype: { name: "Task" },
              project: { key: "IR" },
              labels: ["sprint", "", null, "graph"],
              description: "Boost graph retrieval",
            },
          },
        },
      ],
      [
        "gitlab.get_merge_request",
        {
          iid: 7,
          projectId: 99,
          title: "Merge graph retrieval",
          web_url: "https://gitlab.example/mr/7",
          state: "opened",
          merge_status: "can_be_merged",
          draft: false,
          author: { name: "Author" },
          assignee: { username: "Reviewer" },
          target_branch: "main",
          source_branch: "feature",
          labels: ["backend"],
        },
      ],
      [
        "github.get_pull_request",
        {
          number: 12,
          title: "Graph retrieval",
          html_url: "https://github.example/pull/12",
          state: "open",
          draft: true,
          merged: false,
          closed_at: null,
          user: { login: "author" },
          assignee: { login: "reviewer" },
          head: { repo: { full_name: "redsand/AIWorkAssistant" } },
          base: { ref: "main" },
          labels: [{ name: "ready" }],
        },
      ],
      [
        "github.get_issue",
        {
          number: 13,
          repository: "redsand/AIWorkAssistant",
          title: "Coverage gap",
          html_url: "https://github.example/issues/13",
          state: "open",
          user: { login: "reporter" },
          assignee: { login: "owner" },
          labels: [{ name: "test" }],
          milestone: { title: "Sprint 1" },
        },
      ],
      [
        "github.get_issue",
        {
          number: 14,
          pull_request: {},
          repo: "redsand/AIWorkAssistant",
          title: "PR shaped issue",
          state: "closed",
        },
      ],
      [
        "tenable_cloud.get_asset",
        {
          uuid: "asset-1",
          hostname: "db-01",
          ipv4: "10.0.0.1",
          status: "online",
          severity: "critical",
          acr_score: 750,
          system_owner: "infra",
        },
      ],
      [
        "tenable.get_asset_vulnerabilities",
        {
          plugin: { id: 19506 },
          name: "Nessus Scan Information",
          severity: "info",
          cvss_base_score: 0,
          vpr_score: 1.2,
          state: "open",
        },
      ],
      [
        "hawk_ir.get_case_summary",
        {
          uuid: "case-1",
          title: "Incident",
          state: "investigating",
          severity: "high",
          assigned_to: "analyst",
          priority: "p1",
        },
      ],
      [
        "work_items.create",
        {
          id: "WI-1",
          title: "Write tests",
          sourceUrl: "https://work.example/WI-1",
          status: "open",
          priority: "high",
          owner: "Tim",
          type: "task",
        },
      ],
      [
        "jitbit.get_ticket",
        {
          TicketID: 42,
          subject: "Support request",
          status: "New",
          priority: "High",
          assignedTo: "Support",
          Username: "Customer",
          Category: "Bug",
        },
      ],
      [
        "calendar.get_event",
        {
          eventId: "event-1",
          title: "Planning",
          url: "https://calendar.example/event-1",
          status: "confirmed",
          organizer: { displayName: "Tim" },
          description: "Sprint planning",
        },
      ],
      [
        "gitlab.get_pipeline",
        {
          id: 100,
          project_id: 99,
          web_url: "https://gitlab.example/pipelines/100",
          ref: "main",
          status: "success",
          duration: 123,
        },
      ],
      [
        "github.get_workflow_run",
        {
          id: 200,
          repository: { full_name: "redsand/AIWorkAssistant" },
          html_url: "https://github.example/actions/runs/200",
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
        },
      ],
    ];

    for (const [toolName, payload] of cases) {
      const result = ingestStructuredClaims(toolName, payload, {
        source: "test",
        sourceId: "source-1",
        observedAt: "2026-06-11T12:00:00.000Z",
      });

      expect(result.claimsWritten, toolName).toBeGreaterThan(0);
      expect(result.entitiesTouched, toolName).toBeGreaterThan(0);
      expect(result.skipped, toolName).toBeUndefined();
    }
  });

  it("dispatches plural result payloads by provider and item type", async () => {
    const { ingestStructuredClaims } = await loadExtractor();
    const cases: Array<[string, unknown]> = [
      ["jira.search_issues", { items: [{ key: "IR-83", summary: "Issue", status: "Open" }] }],
      [
        "gitlab.list_merge_requests",
        { results: [{ iid: 8, project_id: 99, title: "MR", state: "opened" }] },
      ],
      [
        "github.list_pull_requests",
        [{ number: 9, repo: "redsand/AIWorkAssistant", title: "PR", state: "open" }],
      ],
      [
        "github.list_issues",
        [{ number: 10, repo: "redsand/AIWorkAssistant", title: "Issue", state: "open" }],
      ],
      ["tenable.list_assets", [{ uuid: "asset-2", fqdn: "web-01", status: "online" }]],
      ["tenable_cloud.list_vulns", [{ plugin_id: 1, plugin_name: "Plugin", severity: "low" }]],
      ["hawk_ir.list_cases", [{ case_id: 2, summary: "Case", status: "new" }]],
      ["work_items.list", [{ id: "WI-2", title: "Work", status: "todo" }]],
      ["jitbit.search_tickets", [{ IssueID: 43, Subject: "Ticket", Status: "Open" }]],
      ["calendar.list_events", [{ id: "event-2", summary: "Review", status: "confirmed" }]],
      ["gitlab.list_pipelines", [{ id: 101, projectId: 99, ref: "dev", status: "failed" }]],
      [
        "github.list_workflow_runs",
        [{ id: 201, repository: { full_name: "redsand/AIWorkAssistant" }, name: "CI" }],
      ],
    ];

    for (const [toolName, payload] of cases) {
      const result = ingestStructuredClaims(toolName, { data: payload });

      expect(result.claimsWritten, toolName).toBeGreaterThan(0);
      expect(result.entitiesTouched, toolName).toBeGreaterThan(0);
    }
  });

  it("extracts fallback identifiers and alternate field shapes", async () => {
    const { ingestStructuredClaims } = await loadExtractor();
    const cases: Array<[string, unknown]> = [
      ["jira.get_issue", { id: "10001", summary: "Issue title", url: "https://jira.example/10001" }],
      ["gitlab.get_merge_request", { id: 22, title: "", state: "merged", url: "https://gitlab.example/mr/22" }],
      ["github.get_pr", { id: 23, url: "https://github.example/pull/23", closed_at: "2026-06-11" }],
      ["tenable.get_asset", { id: "asset-3", ipv4: "10.0.0.3", exposure_score: 42, business_owner: "Biz" }],
      ["tenable.get_asset", { asset_id: "asset-4", fqdn: "web.example.test", status: "offline" }],
      ["tenable.get_vulnerability_details", { cve: "CVE-2026-0001", plugin_name: "CVE vuln", cvss: 7.1, score: 9.3, status: "open" }],
      ["hawk_ir.get_case", { id: 3, summary: "Summary case", status: "closed" }],
      ["work_items.get", { id: 9, title: "Numeric id work item" }],
      ["jitbit.get_ticket", { id: 44, Subject: "Lower id ticket", PriorityName: "Normal", UserName: "User" }],
      ["calendar.get_event", { id: "event-3", summary: "Calendar summary", htmlLink: "https://calendar.example/3" }],
      ["gitlab.get_pipeline", { id: 102, url: "https://gitlab.example/pipelines/102", status: "running" }],
      ["github.get_workflow_run", { id: 202, html_url: "https://github.example/actions/202", status: "queued" }],
    ];

    for (const [toolName, payload] of cases) {
      const result = ingestStructuredClaims(toolName, payload);

      expect(result.claimsWritten, toolName).toBeGreaterThan(0);
      expect(result.entitiesTouched, toolName).toBeGreaterThan(0);
    }
  });

  it("reports skipped and extractor-error outcomes", async () => {
    const { ingestStructuredClaims } = await loadExtractor();
    const malformedTools = [
      "jira.get_issue",
      "gitlab.get_merge_request",
      "github.get_pull_request",
      "github.get_issue",
      "tenable.get_asset",
      "tenable.get_vulnerability_details",
      "hawk_ir.get_case",
      "work_items.get",
      "jitbit.get_ticket",
      "calendar.get_event",
      "gitlab.get_pipeline",
      "github.get_workflow_run",
    ];

    for (const toolName of malformedTools) {
      expect(ingestStructuredClaims(toolName, {}).skipped, toolName).toBe("no_extractor_for_tool");
    }

    expect(ingestStructuredClaims("system.check_health", { status: "ok" })).toEqual({
      claimsWritten: 0,
      entitiesTouched: 0,
      supersessions: 0,
      skipped: "no_extractor_for_tool",
    });
    expect(ingestStructuredClaims("jira.get_issue", null).skipped).toBe("no_extractor_for_tool");
    expect(
      ingestStructuredClaims("gitlab.get_merge_request", {
        iid: 1,
        target_branch: "main",
        source_branch: "feature",
      }),
    ).toEqual({
      claimsWritten: 0,
      entitiesTouched: 0,
      supersessions: 0,
    });

    const throwingIssue = {
      key: "IR-84",
      get summary() {
        throw new Error("summary boom");
      },
    };

    expect(ingestStructuredClaims("jira.get_issue", throwingIssue).skipped).toBe(
      "extractor_error: summary boom",
    );
  });

  it("counts supersessions when a current claim changes", async () => {
    const { ingestStructuredClaims } = await loadExtractor();

    const first = ingestStructuredClaims("jira.get_issue", {
      key: "IR-85",
      status: "Open",
    });
    const second = ingestStructuredClaims("jira.get_issue", {
      key: "IR-85",
      status: "Done",
    });
    const third = ingestStructuredClaims("jira.get_issue", {
      key: "IR-85",
      status: "Done",
    });

    expect(first.supersessions).toBe(0);
    expect(second.supersessions).toBe(1);
    expect(third.supersessions).toBe(0);
  });
});
