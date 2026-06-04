export interface ParsedSchedule {
  kind: "interval" | "cron" | "oneshot";
  minutes?: number;
  cronExpression?: string;
  timestamp?: string;
  original: string;
}

const INTERVAL_RE = /^every\s+(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days)\s*(?:at\s+(\d{1,2}:\d{2}))?$/i;
const CRON_RE = /^([*\d/,.-]+\s+[*\d/,.-]+\s+[*\d/,.-]+\s+[*\d/,.-]+\s+[*\d/,.-]+)$/;
const ONESHOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const NATURAL_DAILY_RE = /^every\s+(?:day|morning|evening|night|afternoon)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
const NATURAL_WEEKLY_RE = /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

const DAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function to24h(hour: number, ampm?: string): number {
  if (!ampm) return hour;
  const upper = ampm.toLowerCase();
  if (upper === "am" && hour === 12) return 0;
  if (upper === "pm" && hour !== 12) return hour + 12;
  return hour;
}

export function parseSchedule(input: string): ParsedSchedule {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Schedule expression cannot be empty");
  }

  // ISO timestamp (one-shot)
  if (ONESHOT_RE.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid timestamp: ${trimmed}`);
    }
    return {
      kind: "oneshot",
      timestamp: parsed.toISOString(),
      original: trimmed,
    };
  }

  // "every day/morning/evening at 9am"
  const dailyMatch = trimmed.match(NATURAL_DAILY_RE);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    const ampm = dailyMatch[3];
    const h = to24h(hour, ampm);
    return {
      kind: "cron",
      cronExpression: `${minute} ${h} * * *`,
      original: trimmed,
    };
  }

  // "every monday at 9am"
  const weeklyMatch = trimmed.match(NATURAL_WEEKLY_RE);
  if (weeklyMatch) {
    const dayName = weeklyMatch[1].toLowerCase();
    const dow = DAY_MAP[dayName];
    const hour = parseInt(weeklyMatch[2], 10);
    const minute = weeklyMatch[3] ? parseInt(weeklyMatch[3], 10) : 0;
    const ampm = weeklyMatch[4];
    const h = to24h(hour, ampm);
    return {
      kind: "cron",
      cronExpression: `${minute} ${h} * * ${dow}`,
      original: trimmed,
    };
  }

  // "every 30m", "every 2h at 09:00"
  const intervalMatch = trimmed.match(INTERVAL_RE);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const atTime = intervalMatch[3];

    let minutes: number;
    if (unit.startsWith("m")) {
      minutes = amount;
    } else if (unit.startsWith("h")) {
      minutes = amount * 60;
    } else {
      minutes = amount * 24 * 60;
    }

    if (atTime) {
      const [h, m] = atTime.split(":").map(Number);
      const cronExpr = `${m} ${h} */${amount} * *`;
      return {
        kind: "cron",
        cronExpression: cronExpr,
        minutes,
        original: trimmed,
      };
    }

    return {
      kind: "interval",
      minutes,
      original: trimmed,
    };
  }

  // Standard 5-field cron expression
  if (CRON_RE.test(trimmed)) {
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Invalid cron expression (expected 5 fields): ${trimmed}`);
    }
    return {
      kind: "cron",
      cronExpression: trimmed,
      original: trimmed,
    };
  }

  throw new Error(
    `Cannot parse schedule: "${trimmed}". ` +
    `Supported formats: "every 30m", "every 2h at 09:00", "every day at 9am", ` +
    `"every monday at 9am", "0 9 * * 1" (cron), "2026-06-15T14:00" (one-shot)`,
  );
}

function expandCronField(field: string, min: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);

  const values: number[] = [];
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, step] = part.split("/");
      const stepNum = parseInt(step, 10);
      const [start, end] = range === "*"
        ? [min, max]
        : range.split("-").map(Number);
      for (let i = start; i <= (end ?? max); i += stepNum) {
        values.push(i);
      }
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return values;
}

export function shouldFireCron(expression: string, now: Date): boolean {
  const fields = expression.split(/\s+/);
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minutes = expandCronField(minuteField, 0, 59);
  const hours = expandCronField(hourField, 0, 23);
  const doms = expandCronField(domField, 1, 31);
  const months = expandCronField(monthField, 1, 12);
  const dows = expandCronField(dowField, 0, 6);

  return (
    minutes.includes(now.getUTCMinutes()) &&
    hours.includes(now.getUTCHours()) &&
    doms.includes(now.getUTCDate()) &&
    months.includes(now.getUTCMonth() + 1) &&
    dows.includes(now.getUTCDay())
  );
}

export function nextFireTime(schedule: ParsedSchedule, after: Date = new Date()): Date | null {
  if (schedule.kind === "oneshot" && schedule.timestamp) {
    return new Date(schedule.timestamp);
  }
  if (schedule.kind === "interval" && schedule.minutes) {
    return new Date(after.getTime() + schedule.minutes * 60_000);
  }
  if (schedule.kind === "cron" && schedule.cronExpression) {
    const test = new Date(after);
    test.setUTCMinutes(test.getUTCMinutes() + 1, 0, 0);
    for (let i = 0; i < 525600; i++) {
      if (shouldFireCron(schedule.cronExpression, test)) return test;
      test.setUTCMinutes(test.getUTCMinutes() + 1);
    }
    return null;
  }
  return null;
}
