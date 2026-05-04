export interface ScheduleEntry {
  time: string;
  title: string;
  type: "meeting" | "focus" | "health" | "break";
  jiraKey?: string;
  description?: string;
}

export interface DayPlan {
  date: string;
  dayOfWeek: string;
  isWeekend: boolean;
  summary: string;
  schedule: ScheduleEntry[];
  priorities: string[];
  recommendations: string[];
}

export interface WeeklyPlan {
  startDate: string;
  endDate: string;
  weekNumber: number;
  summary: string;
  days: DayPlan[];
  taskDistribution: {
    totalTasks: number;
    distributedAcross: number;
    tasksPerDay: Record<string, string[]>;
  };
  weeklyRecommendations: string[];
  jiraUpdates: {
    assigned: number;
    urgent: number;
    blocked: number;
  };
}