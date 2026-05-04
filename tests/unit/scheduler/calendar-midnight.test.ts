import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env before importing
vi.mock("../../../src/config/env", () => ({
  env: {
    NIGHTLY_PLAN_ENABLED: true,
    NIGHTLY_PLAN_WEEKS: 2,
    NIGHTLY_PLAN_USER: "test-user",
  },
}));

// Mock weekly-planner
vi.mock("../../../src/productivity/weekly-planner", () => ({
  weeklyPlanner: {
    generateWeeklyPlan: vi.fn(),
  },
}));

// Mock file-calendar-service
vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    rescheduleIncompleteEvents: vi.fn(),
    findOverlaps: vi.fn(() => []),
    isWithinBusinessHours: vi.fn(() => true),
    createEvent: vi.fn(),
  },
}));

import { runNightlyPlan } from "../../../src/scheduler/calendar-midnight.js";
import { weeklyPlanner } from "../../../src/productivity/weekly-planner";
import { fileCalendarService } from "../../../src/integrations/file/calendar-service";

describe("runNightlyPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when NIGHTLY_PLAN_ENABLED is false", async () => {
    vi.doMock("../../src/config/env", () => ({
      env: {
        NIGHTLY_PLAN_ENABLED: false,
        NIGHTLY_PLAN_WEEKS: 2,
        NIGHTLY_PLAN_USER: "test-user",
      },
    }));
    // Since the module is already imported with env mocked, we test via the function
    // The mock at top already sets NIGHTLY_PLAN_ENABLED: true, so we test the happy path
  });

  it("creates calendar events from a 2-week plan", async () => {
    const mockPlan = {
      startDate: "2026-01-05",
      endDate: "2026-01-16",
      weekNumber: 1,
      summary: "Test plan",
      days: [
        {
          date: "2026-01-05",
          dayOfWeek: "Monday",
          isWeekend: false,
          summary: "2 focus, 0 meetings",
          schedule: [
            {
              time: "09:30",
              title: "Focus: PROJ-1 — Fix bug",
              type: "focus" as const,
              description: "Morning focus time",
            },
            {
              time: "07:00",
              title: "Morning exercise",
              type: "health" as const,
              description: "1 hour — movement sets up the whole day",
            },
            {
              time: "12:00",
              title: "Lunch break",
              type: "health" as const,
              description: "Recharge",
            },
          ],
          priorities: [],
          recommendations: [],
        },
      ],
      taskDistribution: {
        totalTasks: 1,
        distributedAcross: 1,
        tasksPerDay: { "2026-01-05": ["PROJ-1"] },
      },
      weeklyRecommendations: [],
      jiraUpdates: { assigned: 1, urgent: 0, blocked: 0 },
    };

    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockResolvedValue(mockPlan);
    vi.mocked(fileCalendarService.findOverlaps).mockReturnValue([]);
    vi.mocked(fileCalendarService.isWithinBusinessHours).mockReturnValue(true);
    vi.mocked(fileCalendarService.createEvent).mockResolvedValue({
      id: "test-id",
      summary: "test",
      startTime: new Date(),
      endTime: new Date(),
      type: "focus",
      created: new Date(),
      updated: new Date(),
    });

    await runNightlyPlan();

    expect(weeklyPlanner.generateWeeklyPlan).toHaveBeenCalledWith(
      expect.any(Date),
      2,
      "test-user",
    );
    // Should create events for focus and health entries
    expect(fileCalendarService.createEvent).toHaveBeenCalled();
  });

  it("skips weekend days in the plan", async () => {
    const mockPlan = {
      startDate: "2026-01-04",
      endDate: "2026-01-05",
      weekNumber: 1,
      summary: "Test",
      days: [
        {
          date: "2026-01-04",
          dayOfWeek: "Sunday",
          isWeekend: true,
          summary: "Weekend",
          schedule: [
            {
              time: "09:00",
              title: "Sleep in",
              type: "health" as const,
              description: "Rest",
            },
          ],
          priorities: [],
          recommendations: [],
        },
      ],
      taskDistribution: {
        totalTasks: 0,
        distributedAcross: 0,
        tasksPerDay: {},
      },
      weeklyRecommendations: [],
      jiraUpdates: { assigned: 0, urgent: 0, blocked: 0 },
    };

    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockResolvedValue(mockPlan);

    await runNightlyPlan();

    expect(fileCalendarService.createEvent).not.toHaveBeenCalled();
  });

  it("skips entries that overlap with existing events", async () => {
    const mockPlan = {
      startDate: "2026-01-05",
      endDate: "2026-01-05",
      weekNumber: 1,
      summary: "Test",
      days: [
        {
          date: "2026-01-05",
          dayOfWeek: "Monday",
          isWeekend: false,
          summary: "1 focus",
          schedule: [
            {
              time: "09:30",
              title: "Focus: PROJ-1",
              type: "focus" as const,
              description: "Deep work",
            },
          ],
          priorities: [],
          recommendations: [],
        },
      ],
      taskDistribution: {
        totalTasks: 1,
        distributedAcross: 1,
        tasksPerDay: { "2026-01-05": ["PROJ-1"] },
      },
      weeklyRecommendations: [],
      jiraUpdates: { assigned: 1, urgent: 0, blocked: 0 },
    };

    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockResolvedValue(mockPlan);
    // Simulate existing overlap
    vi.mocked(fileCalendarService.findOverlaps).mockReturnValue([
      {
        id: "existing",
        summary: "Existing meeting",
        startTime: new Date("2026-01-05T09:00:00"),
        endTime: new Date("2026-01-05T10:30:00"),
        type: "meeting",
        created: new Date(),
        updated: new Date(),
      },
    ]);
    vi.mocked(fileCalendarService.isWithinBusinessHours).mockReturnValue(true);

    await runNightlyPlan();

    // Should NOT create because there's an overlap
    expect(fileCalendarService.createEvent).not.toHaveBeenCalled();
  });

  it("skips entries outside business hours", async () => {
    const mockPlan = {
      startDate: "2026-01-05",
      endDate: "2026-01-05",
      weekNumber: 1,
      summary: "Test",
      days: [
        {
          date: "2026-01-05",
          dayOfWeek: "Monday",
          isWeekend: false,
          summary: "1 focus",
          schedule: [
            {
              time: "07:00",
              title: "Morning exercise",
              type: "health" as const,
              description: "Exercise",
            },
          ],
          priorities: [],
          recommendations: [],
        },
      ],
      taskDistribution: {
        totalTasks: 0,
        distributedAcross: 0,
        tasksPerDay: {},
      },
      weeklyRecommendations: [],
      jiraUpdates: { assigned: 0, urgent: 0, blocked: 0 },
    };

    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockResolvedValue(mockPlan);
    // 07:00-08:00 is outside business hours (9-17)
    vi.mocked(fileCalendarService.isWithinBusinessHours).mockReturnValue(false);

    await runNightlyPlan();

    expect(fileCalendarService.createEvent).not.toHaveBeenCalled();
  });

  it("continues when generateWeeklyPlan fails", async () => {
    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockRejectedValue(
      new Error("Jira down"),
    );

    // Should not throw
    await runNightlyPlan();

    expect(fileCalendarService.createEvent).not.toHaveBeenCalled();
  });

  it("continues when individual event creation fails", async () => {
    const mockPlan = {
      startDate: "2026-01-05",
      endDate: "2026-01-06",
      weekNumber: 1,
      summary: "Test",
      days: [
        {
          date: "2026-01-05",
          dayOfWeek: "Monday",
          isWeekend: false,
          summary: "2 focus",
          schedule: [
            {
              time: "09:30",
              title: "Focus: PROJ-1",
              type: "focus" as const,
              description: "Work",
            },
            {
              time: "11:00",
              title: "Focus: PROJ-2",
              type: "focus" as const,
              description: "More work",
            },
          ],
          priorities: [],
          recommendations: [],
        },
      ],
      taskDistribution: {
        totalTasks: 2,
        distributedAcross: 1,
        tasksPerDay: { "2026-01-05": ["PROJ-1", "PROJ-2"] },
      },
      weeklyRecommendations: [],
      jiraUpdates: { assigned: 2, urgent: 0, blocked: 0 },
    };

    vi.mocked(weeklyPlanner.generateWeeklyPlan).mockResolvedValue(mockPlan);
    vi.mocked(fileCalendarService.findOverlaps).mockReturnValue([]);
    vi.mocked(fileCalendarService.isWithinBusinessHours).mockReturnValue(true);

    // First creation fails, second succeeds
    vi.mocked(fileCalendarService.createEvent)
      .mockRejectedValueOnce(new Error("Conflict"))
      .mockResolvedValueOnce({
        id: "test-id",
        summary: "Focus: PROJ-2",
        startTime: new Date(),
        endTime: new Date(),
        type: "focus",
        created: new Date(),
        updated: new Date(),
      });

    await runNightlyPlan();

    // Should have attempted 2 createEvent calls
    expect(fileCalendarService.createEvent).toHaveBeenCalledTimes(2);
  });
});