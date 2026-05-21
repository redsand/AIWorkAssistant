import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../../src/integrations/jira/jira-service", () => ({
  jiraService: {
    getAssignedIssues: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    listEvents: vi.fn(),
  },
}));

import { weeklyPlanner } from "../../../src/productivity/weekly-planner";
import { jiraService } from "../../../src/integrations/jira/jira-service";
import { fileCalendarService } from "../../../src/integrations/file/calendar-service";

// ---------------------------------------------------------------------------
// Helpers to build Jira issue fixtures
// ---------------------------------------------------------------------------

function makeJiraIssue(overrides: {
  key?: string;
  summary?: string;
  priorityName?: string;
  statusName?: string;
  statusCategoryKey?: string;
  updated?: string;
}): any {
  return {
    key: overrides.key ?? "PROJ-1",
    fields: {
      summary: overrides.summary ?? "Some task",
      priority: { name: overrides.priorityName ?? "Medium" },
      status: {
        name: overrides.statusName ?? "In Progress",
        statusCategory: { key: overrides.statusCategoryKey ?? "in_flight" },
      },
      updated: overrides.updated ?? "2026-05-19T10:00:00.000Z",
    },
  };
}

// Helpers to build calendar event fixtures
function makeCalendarEvent(
  summary: string,
  startTime: Date,
  endTime: Date,
  type?: string,
): any {
  return {
    summary,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    ...(type ? { type } : {}),
  };
}

// Monday of a known week: 2026-05-18 is a Monday
function mondayDate(): Date {
  return new Date(2026, 4, 18); // month is 0-indexed; May = 4
}

// Reset mocks between tests
beforeEach(() => {
  vi.mocked(jiraService.getAssignedIssues).mockReset();
  vi.mocked(fileCalendarService.listEvents).mockReset();
});

// ===========================================================================
// extractJiraIssues (pure function)
// ===========================================================================

describe("extractJiraIssues", () => {
  // The function is not exported but is exercised via generateWeeklyPlan / generateDayPlan.
  // We test its behavior indirectly through those public methods, and also by calling
  // it through the module's internal path. Since it is a module-level function (not
  // exported), we verify its effects through the public API.

  // However, the file re-exports `weeklyPlanner` which uses these internally.
  // To test them directly, we rely on the fact that they are pure helpers scoped
  // to the module. We'll test the observable behavior through the class methods,
  // and also validate edge cases by feeding specific Jira payloads.

  it("is exercised: issues with done statusCategory are excluded", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "DONE-1", statusCategoryKey: "done" }),
      makeJiraIssue({ key: "OPEN-1", statusCategoryKey: "in_flight" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    // Only the non-done issue should appear in priorities
    expect(plan.priorities.length).toBe(1);
    expect(plan.priorities[0]).toContain("OPEN-1");
  });

  it("is exercised: issues with status name 'closed' / 'resolved' / 'done' are excluded", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "A-1", statusName: "Closed" }),
      makeJiraIssue({ key: "A-2", statusName: "Resolved" }),
      makeJiraIssue({ key: "A-3", statusName: "Done" }),
      makeJiraIssue({ key: "A-4", statusName: "In Progress" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities).toHaveLength(1);
    expect(plan.priorities[0]).toContain("A-4");
  });

  it("is exercised: issues without key fallback to UNKNOWN", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      {
        key: undefined,
        fields: {
          summary: "Orphan issue",
          priority: { name: "Medium" },
          status: { name: "Open", statusCategory: { key: "in_flight" } },
          updated: "2026-05-19T10:00:00.000Z",
        },
      },
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities[0]).toContain("UNKNOWN");
  });

  it("is exercised: issues without fields.summary fall back to issue key", async () => {
    const raw = {
      key: "NO-SUM-1",
      fields: {
        summary: undefined,
        priority: { name: "High" },
        status: { name: "Open", statusCategory: { key: "in_flight" } },
        updated: "2026-05-19T10:00:00.000Z",
      },
    };
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([raw]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities[0]).toContain("NO-SUM-1");
  });
});

// ===========================================================================
// sortIssuesByPriority (pure function)
// ===========================================================================

describe("sortIssuesByPriority", () => {
  it("sorts highest priority first", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "LOW-1", priorityName: "Low", updated: "2026-05-17T10:00:00.000Z" }),
      makeJiraIssue({ key: "HIGH-1", priorityName: "High", updated: "2026-05-17T10:00:00.000Z" }),
      makeJiraIssue({ key: "CRIT-1", priorityName: "Highest", updated: "2026-05-17T10:00:00.000Z" }),
      makeJiraIssue({ key: "MED-1", priorityName: "Medium", updated: "2026-05-17T10:00:00.000Z" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    // Only first 2 tasks appear in a single day plan (MAX_FOCUS_TASKS_PER_DAY=2)
    expect(plan.priorities).toHaveLength(2);
    // The first should be the highest-priority issue
    expect(plan.priorities[0]).toContain("CRIT-1");
  });

  it("sorts P0/P1/P2/P3 aliases correctly", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "P2-1", priorityName: "P2", updated: "2026-05-18T10:00:00.000Z" }),
      makeJiraIssue({ key: "P0-1", priorityName: "P0", updated: "2026-05-18T10:00:00.000Z" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities[0]).toContain("P0-1");
  });

  it("breaks ties by updated date (older first)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "NEWER", priorityName: "Medium", updated: "2026-05-19T10:00:00.000Z" }),
      makeJiraIssue({ key: "OLDER", priorityName: "Medium", updated: "2026-05-15T10:00:00.000Z" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities[0]).toContain("OLDER");
  });

  it("treats unknown priority as medium", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "UNKNOWN-P", priorityName: "WeirdPriority", updated: "2026-05-18T10:00:00.000Z" }),
      makeJiraIssue({ key: "LOW-P", priorityName: "Low", updated: "2026-05-18T10:00:00.000Z" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    // Unknown priority should be treated as medium (index 2), which sorts before low (index 3)
    expect(plan.priorities[0]).toContain("UNKNOWN-P");
  });
});

// ===========================================================================
// distributeTasks (pure function, tested via generateWeeklyPlan)
// ===========================================================================

describe("distributeTasks", () => {
  it("limits to MAX_FOCUS_TASKS_PER_DAY (2) per day", async () => {
    const issues = Array.from({ length: 12 }, (_, i) =>
      makeJiraIssue({ key: `TASK-${i + 1}`, priorityName: "Medium" }),
    );
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue(issues);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");

    // 5 weekdays * 2 tasks = 10 distributed; 2 overflow
    expect(plan.taskDistribution.totalTasks).toBe(12);
    expect(plan.taskDistribution.distributedAcross).toBe(5);

    // Each day should have at most 2 tasks
    for (const tasks of Object.values(plan.taskDistribution.tasksPerDay)) {
      expect(tasks.length).toBeLessThanOrEqual(2);
    }
  });

  it("returns empty distribution when there are no issues", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.taskDistribution.totalTasks).toBe(0);
    expect(plan.taskDistribution.distributedAcross).toBe(0);
  });

  it("distributes 2-week span (10 weekdays) correctly", async () => {
    const issues = Array.from({ length: 20 }, (_, i) =>
      makeJiraIssue({ key: `W2-${i + 1}`, priorityName: "Medium" }),
    );
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue(issues);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 2, "user1");
    expect(plan.taskDistribution.distributedAcross).toBe(10);
    expect(plan.days).toHaveLength(10);
  });
});

// ===========================================================================
// WeeklyPlanner.generateWeeklyPlan
// ===========================================================================

describe("WeeklyPlanner.generateWeeklyPlan", () => {
  it("produces a valid WeeklyPlan structure for a 1-week plan", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "WP-1", priorityName: "High" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");

    // 5 weekdays
    expect(plan.days).toHaveLength(5);
    expect(plan.startDate).toBe("2026-05-18");
    // Friday 2026-05-22
    expect(plan.endDate).toBe("2026-05-22");
    expect(plan.weekNumber).toBeGreaterThan(0);
    expect(plan.summary).toContain("focus blocks");
    expect(plan.jiraUpdates.assigned).toBe(1);
    expect(plan.jiraUpdates.urgent).toBe(1);
    expect(plan.jiraUpdates.blocked).toBe(0);
  });

  it("counts urgent tasks correctly (highest/high/critical/p0/p1)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "U-1", priorityName: "Highest" }),
      makeJiraIssue({ key: "U-2", priorityName: "High" }),
      makeJiraIssue({ key: "U-3", priorityName: "Critical" }),
      makeJiraIssue({ key: "U-4", priorityName: "P0" }),
      makeJiraIssue({ key: "U-5", priorityName: "P1" }),
      makeJiraIssue({ key: "U-6", priorityName: "Medium" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.jiraUpdates.urgent).toBe(5);
  });

  it("counts blocked tasks correctly", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "B-1", statusName: "Blocked" }),
      makeJiraIssue({ key: "B-2", statusName: "In Progress" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.jiraUpdates.blocked).toBe(1);
  });

  it("generates overflow recommendation when tasks exceed capacity", async () => {
    // 5 weekdays * 2 max = 10 task slots; provide 15
    const issues = Array.from({ length: 15 }, (_, i) =>
      makeJiraIssue({ key: `OVER-${i + 1}`, priorityName: "Medium" }),
    );
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue(issues);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    const overflowRec = plan.weeklyRecommendations.find((r) =>
      r.includes("more task"),
    );
    expect(overflowRec).toBeDefined();
    expect(overflowRec).toContain("5 more tasks queued");
  });

  it("generates urgent recommendation when urgent tasks exist", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "URG-1", priorityName: "Highest" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    const urgentRec = plan.weeklyRecommendations.find((r) =>
      r.includes("urgent"),
    );
    expect(urgentRec).toBeDefined();
    expect(urgentRec).toContain("front-load");
  });

  it("generates blocked recommendation when blocked tasks exist", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "BLK-1", statusName: "Blocked" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    const blockedRec = plan.weeklyRecommendations.find((r) =>
      r.includes("blocked"),
    );
    expect(blockedRec).toBeDefined();
  });

  it("generates no-issues recommendation when zero issues assigned", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    const noIssuesRec = plan.weeklyRecommendations.find((r) =>
      r.includes("No Jira issues"),
    );
    expect(noIssuesRec).toBeDefined();
  });

  it("finds Monday when start date is a Wednesday", async () => {
    const wednesday = new Date(2026, 4, 20); // Wed May 20 2026
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(wednesday, 1, "user1");
    expect(plan.startDate).toBe("2026-05-18"); // Monday
  });

  it("finds Monday when start date is a Sunday (rolls forward)", async () => {
    const sunday = new Date(2026, 4, 17); // Sun May 17 2026
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(sunday, 1, "user1");
    expect(plan.startDate).toBe("2026-05-18"); // Monday
  });

  it("stays on same day when start date is already Monday", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.startDate).toBe("2026-05-18");
  });

  it("includes calendar events in day plans", async () => {
    const eventDay = new Date(2026, 4, 19); // Tue May 19
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Team Sync", eventDay, new Date(2026, 4, 19, 10, 0), "meeting"),
    ]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    // Find the Tuesday plan
    const tuesday = plan.days.find((d) => d.date === "2026-05-19");
    expect(tuesday).toBeDefined();
    const meetings = tuesday!.schedule.filter((s) => s.title === "Team Sync");
    expect(meetings).toHaveLength(1);
    expect(meetings[0].type).toBe("meeting");
  });

  it("gracefully handles jiraService.getAssignedIssues rejection", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockRejectedValue(new Error("Jira down"));
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    // Should still produce a valid plan with 0 tasks
    expect(plan.jiraUpdates.assigned).toBe(0);
    expect(plan.days).toHaveLength(5);
  });

  it("includes summary with exercise day names (Mon/Wed/Fri)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.summary).toContain("Mon");
    expect(plan.summary).toContain("Wed");
    expect(plan.summary).toContain("Fri");
  });
});

// ===========================================================================
// WeeklyPlanner.generateDayPlan
// ===========================================================================

describe("WeeklyPlanner.generateDayPlan", () => {
  it("returns a weekend plan for Saturday", async () => {
    const saturday = new Date(2026, 4, 23); // Sat May 23
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(saturday, "user1");
    expect(plan.isWeekend).toBe(true);
    expect(plan.dayOfWeek).toBe("Saturday");
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0].type).toBe("health");
    expect(plan.priorities).toHaveLength(0);
  });

  it("returns a weekend plan for Sunday", async () => {
    const sunday = new Date(2026, 4, 24); // Sun May 24
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(sunday, "user1");
    expect(plan.isWeekend).toBe(true);
    expect(plan.dayOfWeek).toBe("Sunday");
  });

  it("returns a weekday plan with focus blocks on Monday", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "FOCUS-1", summary: "Important feature" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.isWeekend).toBe(false);
    expect(plan.dayOfWeek).toBe("Monday");
    expect(plan.date).toBe("2026-05-18");

    // Should have focus blocks for the task
    const focusEntries = plan.schedule.filter((s) => s.type === "focus");
    expect(focusEntries.length).toBeGreaterThanOrEqual(1);

    // Should have exercise on Monday (Mon=1 is in EXERCISE_DAYS)
    const exercise = plan.schedule.filter((s) =>
      s.type === "health" && s.title === "Morning exercise",
    );
    expect(exercise).toHaveLength(1);
    expect(exercise[0].time).toBe("07:00");
  });

  it("includes morning exercise only on Mon/Wed/Fri", async () => {
    // Tuesday -- no exercise
    const tuesday = new Date(2026, 4, 19);
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const tuesdayPlan = await weeklyPlanner.generateDayPlan(tuesday, "user1");
    const exercise = tuesdayPlan.schedule.filter(
      (s) => s.title === "Morning exercise",
    );
    expect(exercise).toHaveLength(0);

    // Wednesday -- exercise
    const wednesday = new Date(2026, 4, 20);
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const wedPlan = await weeklyPlanner.generateDayPlan(wednesday, "user1");
    const wedExercise = wedPlan.schedule.filter(
      (s) => s.title === "Morning exercise",
    );
    expect(wedExercise).toHaveLength(1);
  });

  it("caps focus tasks at MAX_FOCUS_TASKS_PER_DAY (2)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "T-1" }),
      makeJiraIssue({ key: "T-2" }),
      makeJiraIssue({ key: "T-3" }),
      makeJiraIssue({ key: "T-4" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    // priorities list only the capped tasks
    expect(plan.priorities).toHaveLength(2);
  });

  it("uses full day template when no calendar events exist", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");

    // Full template includes standup, lunch, review, etc.
    const times = plan.schedule.map((s) => s.time);
    expect(times).toContain("09:00"); // standup
    expect(times).toContain("12:00"); // lunch
    expect(times).toContain("15:45"); // review
  });

  it("merges existing calendar events instead of full template", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Design Review", new Date(2026, 4, 18, 10, 0), new Date(2026, 4, 18, 11, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const designReview = plan.schedule.find((s) => s.title === "Design Review");
    expect(designReview).toBeDefined();
    expect(designReview!.type).toBe("meeting");
  });

  it("maps calendar event types to schedule entry types", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Focus time", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 10, 0), "focus"),
      makeCalendarEvent("Gym", new Date(2026, 4, 18, 7, 0), new Date(2026, 4, 18, 8, 0), "fitness"),
      makeCalendarEvent("Other thing", new Date(2026, 4, 18, 16, 0), new Date(2026, 4, 18, 17, 0), "other"),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const focusEvent = plan.schedule.find((s) => s.title === "Focus time");
    const gymEvent = plan.schedule.find((s) => s.title === "Gym");
    const otherEvent = plan.schedule.find((s) => s.title === "Other thing");

    expect(focusEvent!.type).toBe("focus");
    expect(gymEvent!.type).toBe("health");
    expect(otherEvent!.type).toBe("break");
  });

  it("adds focus blocks in schedule gaps when tasks exist", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "GAP-1", summary: "Gap task" }),
    ]);
    // One event that leaves a large gap
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Early meeting", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 9, 30)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const focusWithJira = plan.schedule.filter(
      (s) => s.type === "focus" && s.jiraKey === "GAP-1",
    );
    expect(focusWithJira.length).toBeGreaterThanOrEqual(1);
  });

  it("skips exercise when calendar conflict exists at 07:00", async () => {
    const day = mondayDate(); // Monday -- exercise day
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      // Event overlapping 07:00-08:00 exercise window
      makeCalendarEvent("Early call", new Date(2026, 4, 18, 6, 30), new Date(2026, 4, 18, 8, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const exercise = plan.schedule.filter(
      (s) => s.title === "Morning exercise",
    );
    expect(exercise).toHaveLength(0);
  });

  it("recommendation: heavy meeting day (>3 meetings)", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("M1", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 9, 30)),
      makeCalendarEvent("M2", new Date(2026, 4, 18, 10, 0), new Date(2026, 4, 18, 10, 30)),
      makeCalendarEvent("M3", new Date(2026, 4, 18, 11, 0), new Date(2026, 4, 18, 11, 30)),
      makeCalendarEvent("M4", new Date(2026, 4, 18, 13, 0), new Date(2026, 4, 18, 13, 30)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const heavyRec = plan.recommendations.find((r) =>
      r.includes("Heavy meeting day"),
    );
    expect(heavyRec).toBeDefined();
  });

  it("recommendation: no focus blocks when tasks exist but schedule is full", async () => {
    // Use Tuesday so no exercise is injected
    const day = new Date(2026, 4, 19); // Tue May 19
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "STUCK-1" }),
    ]);
    // Fill the entire business day (9:00-17:00) with tightly packed meetings.
    // The gap finder assumes 90-min per slot, so use 90-min spacing.
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("M1", new Date(2026, 4, 19, 9, 0), new Date(2026, 4, 19, 10, 30)),
      makeCalendarEvent("M2", new Date(2026, 4, 19, 10, 30), new Date(2026, 4, 19, 12, 0)),
      makeCalendarEvent("M3", new Date(2026, 4, 19, 12, 0), new Date(2026, 4, 19, 13, 30)),
      makeCalendarEvent("M4", new Date(2026, 4, 19, 13, 30), new Date(2026, 4, 19, 15, 0)),
      makeCalendarEvent("M5", new Date(2026, 4, 19, 15, 0), new Date(2026, 4, 19, 16, 30)),
      makeCalendarEvent("M6", new Date(2026, 4, 19, 16, 30), new Date(2026, 4, 19, 17, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const noFocusRec = plan.recommendations.find((r) =>
      r.includes("No focus blocks today"),
    );
    expect(noFocusRec).toBeDefined();
  });

  it("recommendation: tasks queued message when tasks exist", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "Q-1" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    const queuedRec = plan.recommendations.find((r) =>
      r.includes("task") && r.includes("queued"),
    );
    expect(queuedRec).toBeDefined();
  });

  it("gracefully handles jiraService.getAssignedIssues rejection in day plan", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockRejectedValue(new Error("Network error"));
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.isWeekend).toBe(false);
    expect(plan.priorities).toHaveLength(0);
  });

  it("sorts schedule entries by time", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Late", new Date(2026, 4, 18, 15, 0), new Date(2026, 4, 18, 16, 0)),
      makeCalendarEvent("Early", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 9, 30)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const times = plan.schedule.map((s) => s.time);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });

  it("adds lunch when not already present in merged schedule", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    // Events that do not cover lunch hour
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Morning", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 10, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const lunch = plan.schedule.find(
      (s) => s.title === "Lunch break",
    );
    expect(lunch).toBeDefined();
    expect(lunch!.time).toBe("12:00");
  });

  it("does not add duplicate lunch when health entry at 12:xx exists", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Lunch with team", new Date(2026, 4, 18, 12, 0), new Date(2026, 4, 18, 13, 0), "meal"),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const lunchEntries = plan.schedule.filter((s) =>
      s.type === "health" && s.time.startsWith("12"),
    );
    // Only the existing one; no duplicate added
    expect(lunchEntries).toHaveLength(1);
  });

  it("adds afternoon walk when no health break in 14:00-16:00 range", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Morning", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 10, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const walk = plan.schedule.find(
      (s) => s.title === "Afternoon reset — stretch, walk, breathe",
    );
    expect(walk).toBeDefined();
    expect(walk!.time).toBe("14:15");
  });
});

// ===========================================================================
// Edge cases and boundary conditions
// ===========================================================================

describe("edge cases", () => {
  it("handles empty issues and empty calendar events", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.isWeekend).toBe(false);
    expect(plan.priorities).toHaveLength(0);
    // Should still have schedule entries from the template
    expect(plan.schedule.length).toBeGreaterThan(0);
  });

  it("handles a single low-priority issue", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "LOW-1", priorityName: "Low" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities).toHaveLength(1);
    expect(plan.priorities[0]).toContain("LOW-1");
  });

  it("handles issue with missing priority gracefully (defaults to medium)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      {
        key: "NOPRI-1",
        fields: {
          summary: "No priority",
          priority: null,
          status: { name: "Open", statusCategory: { key: "in_flight" } },
          updated: "2026-05-19T10:00:00.000Z",
        },
      },
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities).toHaveLength(1);
    expect(plan.priorities[0]).toContain("medium");
  });

  it("handles issue with missing status (defaults to open)", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      {
        key: "NOST-1",
        fields: {
          summary: "No status",
          priority: { name: "Medium" },
          status: null,
          updated: "2026-05-19T10:00:00.000Z",
        },
      },
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities).toHaveLength(1);
  });

  it("handles issue missing all fields gracefully", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      {
        key: "EMPTY-1",
        fields: {},
      },
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.priorities).toHaveLength(1);
    expect(plan.priorities[0]).toContain("EMPTY-1");
  });

  it("produces correct ISO date format in day plan", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    expect(plan.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("weekly plan summary contains lightest and heaviest day names", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "T-1", priorityName: "High" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    expect(plan.summary).toContain("Lightest day:");
    expect(plan.summary).toContain("Heaviest:");
  });

  it("calendar events on different days are grouped correctly in weekly plan", async () => {
    const mon = new Date(2026, 4, 18);
    const tue = new Date(2026, 4, 19);
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Mon event", mon, new Date(2026, 4, 18, 10, 0)),
      makeCalendarEvent("Tue event", tue, new Date(2026, 4, 19, 10, 0)),
    ]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");

    const monDay = plan.days.find((d) => d.date === "2026-05-18");
    const tueDay = plan.days.find((d) => d.date === "2026-05-19");

    expect(monDay!.schedule.some((s) => s.title === "Mon event")).toBe(true);
    expect(tueDay!.schedule.some((s) => s.title === "Tue event")).toBe(true);
    // Mon event should NOT appear on Tuesday
    expect(tueDay!.schedule.some((s) => s.title === "Mon event")).toBe(false);
  });

  it("exercise event type maps to health type in schedule", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Gym session", new Date(2026, 4, 18, 7, 0), new Date(2026, 4, 18, 8, 0), "fitness"),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const gym = plan.schedule.find((s) => s.title === "Gym session");
    expect(gym).toBeDefined();
    expect(gym!.type).toBe("health");
  });

  it("meal event type maps to health type in schedule", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Team lunch", new Date(2026, 4, 18, 12, 0), new Date(2026, 4, 18, 13, 0), "meal"),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const lunch = plan.schedule.find((s) => s.title === "Team lunch");
    expect(lunch).toBeDefined();
    expect(lunch!.type).toBe("health");
  });

  it("mental_health event type maps to health type in schedule", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("Therapy", new Date(2026, 4, 18, 14, 0), new Date(2026, 4, 18, 15, 0), "mental_health"),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const therapy = plan.schedule.find((s) => s.title === "Therapy");
    expect(therapy).toBeDefined();
    expect(therapy!.type).toBe("health");
  });

  it("very little free time recommendation triggers", async () => {
    const day = mondayDate();
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    // Pack the entire business day
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      makeCalendarEvent("B1", new Date(2026, 4, 18, 9, 0), new Date(2026, 4, 18, 10, 30)),
      makeCalendarEvent("B2", new Date(2026, 4, 18, 10, 30), new Date(2026, 4, 18, 12, 0)),
      makeCalendarEvent("B3", new Date(2026, 4, 18, 12, 0), new Date(2026, 4, 18, 13, 0)),
      makeCalendarEvent("B4", new Date(2026, 4, 18, 13, 0), new Date(2026, 4, 18, 14, 30)),
      makeCalendarEvent("B5", new Date(2026, 4, 18, 14, 30), new Date(2026, 4, 18, 16, 0)),
      makeCalendarEvent("B6", new Date(2026, 4, 18, 16, 0), new Date(2026, 4, 18, 17, 0)),
    ]);

    const plan = await weeklyPlanner.generateDayPlan(day, "user1");
    const freeRec = plan.recommendations.find((r) =>
      r.includes("Very little free time"),
    );
    expect(freeRec).toBeDefined();
  });

  it("jiraKey is set on focus blocks that have assigned tasks", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "JK-1", summary: "Task with key" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateDayPlan(mondayDate(), "user1");
    const focusWithKey = plan.schedule.filter(
      (s) => s.type === "focus" && s.jiraKey === "JK-1",
    );
    expect(focusWithKey.length).toBeGreaterThanOrEqual(1);
  });

  it("2-week plan spans 10 weekdays", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 2, "user1");
    // 2 weeks * 5 weekdays = 10
    expect(plan.days).toHaveLength(10);
    // End date should be Friday of second week: 2026-05-29
    expect(plan.endDate).toBe("2026-05-29");
  });

  it("taskDistribution.tasksPerDay has entries for each weekday", async () => {
    vi.mocked(jiraService.getAssignedIssues).mockResolvedValue([
      makeJiraIssue({ key: "DIST-1" }),
    ]);
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([]);

    const plan = await weeklyPlanner.generateWeeklyPlan(mondayDate(), 1, "user1");
    const dates = Object.keys(plan.taskDistribution.tasksPerDay);
    // 5 weekdays
    expect(dates).toHaveLength(5);
  });
});
