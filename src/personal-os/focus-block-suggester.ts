import type { FocusBlockSuggestion, EnergyRisk, OpenLoop } from "./types";

interface CalendarEvent {
  startTime?: string | Date;
  endTime?: string | Date;
  summary?: string;
  type?: string;
}

class FocusBlockSuggester {
  suggestFocusBlocks(
    calendarEvents: CalendarEvent[],
    openLoops: OpenLoop[],
    date: string,
    minDurationMinutes: number = 60,
  ): FocusBlockSuggestion[] {
    const suggestions: FocusBlockSuggestion[] = [];
    const gaps = this.findGaps(calendarEvents, date, minDurationMinutes);

    if (gaps.length === 0) return suggestions;

    // Rank open loops by urgency for prioritization
    const urgencyOrder: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };
    const rankedLoops = [...openLoops].sort(
      (a, b) => (urgencyOrder[b.urgency] || 0) - (urgencyOrder[a.urgency] || 0),
    );

    // Suggest focus blocks for each gap
    for (const gap of gaps) {
      const durationMin = gap.durationMinutes;
      const isAfternoon = gap.startHour >= 13;
      const isLate = gap.startHour >= 15;

      // Deep work for longer gaps, admin for shorter ones
      if (durationMin >= 90 && rankedLoops.length > 0) {
        const topLoop = rankedLoops[0];
        suggestions.push({
          startTime: gap.startTime,
          durationMinutes: Math.min(durationMin, 120),
          title: isLate ? "Deep work (late day — consider lighter tasks)" : "Deep work block",
          reason: `Tackle highest-priority open loop: ${topLoop.title}`,
          priority: topLoop.urgency === "critical" || topLoop.urgency === "high" ? "high" : "medium",
        });
        rankedLoops.shift();
      } else if (durationMin >= 60) {
        suggestions.push({
          startTime: gap.startTime,
          durationMinutes: 60,
          title: isAfternoon ? "Review and follow-up block" : "Focus block",
          reason: "Clear review queue and follow-up items",
          priority: "medium",
        });
      } else if (durationMin >= 30) {
        suggestions.push({
          startTime: gap.startTime,
          durationMinutes: 30,
          title: "Admin / triage block",
          reason: "Quick approvals, inbox triage, and status updates",
          priority: "low",
        });
      }
    }

    return suggestions;
  }

  detectEnergyRisks(
    calendarEvents: CalendarEvent[],
    suggestions: FocusBlockSuggestion[],
  ): EnergyRisk[] {
    const risks: EnergyRisk[] = [];
    const parsedEvents = calendarEvents
      .map((e) => ({
        start: this.parseHour(e.startTime),
        end: this.parseHour(e.endTime),
        summary: e.summary || "Meeting",
      }))
      .filter((e) => e.start !== null && e.end !== null)
      .sort((a, b) => (a.start as number) - (b.start as number));

    // Back-to-back meetings
    for (let i = 0; i < parsedEvents.length - 1; i++) {
      const current = parsedEvents[i];
      const next = parsedEvents[i + 1];
      if (current.end !== null && next.start !== null && Math.abs((next.start as number) - (current.end as number)) < 0.25) {
        risks.push({
          type: "back_to_back",
          description: `Back-to-back: "${current.summary}" → "${next.summary}"`,
          severity: "medium",
          affectedTime: `${this.formatHour(current.start)}-${this.formatHour(next.end)}`,
        });
      }
    }

    // No breaks between multiple meetings
    const totalMeetingHours = parsedEvents.reduce((sum, e) => {
      if (e.start !== null && e.end !== null) return sum + ((e.end as number) - (e.start as number));
      return sum;
    }, 0);
    if (totalMeetingHours >= 4) {
      risks.push({
        type: "meeting_overload",
        description: `${totalMeetingHours.toFixed(1)} hours of meetings — limited time for deep work`,
        severity: totalMeetingHours >= 6 ? "high" : "medium",
      });
    }

    // Late-day deep work
    const lateDeepWork = suggestions.filter(
      (s) => s.title.includes("Deep work") && s.startTime.includes("T15") || s.startTime.includes("T16"),
    );
    for (const block of lateDeepWork) {
      risks.push({
        type: "late_day_deep_work",
        description: `Deep work block at ${this.formatTime(block.startTime)} — energy typically lower late in the day`,
        severity: "low",
        affectedTime: this.formatTime(block.startTime),
      });
    }

    // No breaks detected
    if (parsedEvents.length >= 3 && totalMeetingHours >= 2) {
      const hasBreak = parsedEvents.some((e, i) => {
        if (i === 0) return false;
        const prev = parsedEvents[i - 1];
        return prev.end !== null && e.start !== null && (e.start as number) - (prev.end as number) >= 0.5;
      });
      if (!hasBreak) {
        risks.push({
          type: "no_breaks",
          description: "No significant breaks between meetings today",
          severity: "medium",
        });
      }
    }

    return risks;
  }

  private findGaps(
    events: CalendarEvent[],
    date: string,
    minDurationMinutes: number,
  ): Array<{
    startTime: string;
    startHour: number;
    durationMinutes: number;
  }> {
    const gaps: Array<{
      startTime: string;
      startHour: number;
      durationMinutes: number;
    }> = [];

    const workStart = 9;
    const workEnd = 17;

    const parsed = events
      .map((e) => ({
        start: this.parseHour(e.startTime),
        end: this.parseHour(e.endTime),
      }))
      .filter((e) => e.start !== null && e.end !== null)
      .sort((a, b) => (a.start as number) - (b.start as number));

    let cursor = workStart;
    for (const event of parsed) {
      const eStart = event.start as number;
      const eEnd = event.end as number;
      if (eStart > cursor) {
        const gapMinutes = (eStart - cursor) * 60;
        if (gapMinutes >= minDurationMinutes) {
          gaps.push({
            startTime: `${date}T${this.hourToTime(cursor)}`,
            startHour: cursor,
            durationMinutes: gapMinutes,
          });
        }
      }
      if (eEnd > cursor) cursor = eEnd;
    }

    if (cursor < workEnd) {
      const gapMinutes = (workEnd - cursor) * 60;
      if (gapMinutes >= minDurationMinutes) {
        gaps.push({
          startTime: `${date}T${this.hourToTime(cursor)}`,
          startHour: cursor,
          durationMinutes: gapMinutes,
        });
      }
    }

    return gaps;
  }

  private parseHour(time: string | Date | undefined): number | null {
    if (!time) return null;
    const d = new Date(time);
    if (Number.isNaN(d.getTime())) return null;
    return d.getHours() + d.getMinutes() / 60;
  }

  private hourToTime(hour: number): string {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  }

  private formatHour(hour: number | null): string {
    if (hour === null) return "?";
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  private formatTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch {
      return isoString;
    }
  }
}

export const focusBlockSuggester = new FocusBlockSuggester();