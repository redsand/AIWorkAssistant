/**
 * File-based Calendar Service
 * Simple calendar management without external API dependencies
 * Perfect for local development
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  type: 'meeting' | 'focus' | 'fitness' | 'meal' | 'mental_health' | 'other';
  created: Date;
  updated: Date;
}

export interface CreateEventParams {
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  type?: CalendarEvent['type'];
}

class FileCalendarService {
  private calendarDir: string;

  constructor() {
    this.calendarDir = join(process.cwd(), 'data', 'calendar');
    this.ensureDirectory();
  }

  /**
   * Ensure calendar directory exists
   */
  private ensureDirectory() {
    if (!existsSync(this.calendarDir)) {
      mkdirSync(this.calendarDir, { recursive: true });
    }
  }

  /**
   * Get file path for an event
   */
  private getEventPath(eventId: string): string {
    return join(this.calendarDir, `${eventId}.json`);
  }

  /**
   * Create a new event
   */
  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const event: CalendarEvent = {
      id: uuidv4(),
      summary: params.summary,
      description: params.description,
      startTime: params.startTime,
      endTime: params.endTime,
      location: params.location,
      type: params.type || 'other',
      created: new Date(),
      updated: new Date(),
    };

    this.saveEvent(event);
    console.log(`[FileCalendar] Created event: ${event.summary}`);
    return event;
  }

  /**
   * Update an existing event
   */
  async updateEvent(eventId: string, params: Partial<CreateEventParams>): Promise<CalendarEvent> {
    const existing = this.getEvent(eventId);
    if (!existing) {
      throw new Error('Event not found');
    }

    const updated: CalendarEvent = {
      ...existing,
      summary: params.summary || existing.summary,
      description: params.description !== undefined ? params.description : existing.description,
      startTime: params.startTime || existing.startTime,
      endTime: params.endTime || existing.endTime,
      location: params.location !== undefined ? params.location : existing.location,
      type: params.type || existing.type,
      updated: new Date(),
    };

    this.saveEvent(updated);
    console.log(`[FileCalendar] Updated event: ${updated.summary}`);
    return updated;
  }

  /**
   * Delete an event
   */
  async deleteEvent(eventId: string): Promise<boolean> {
    const eventPath = this.getEventPath(eventId);
    if (existsSync(eventPath)) {
      unlinkSync(eventPath);
      console.log(`[FileCalendar] Deleted event: ${eventId}`);
      return true;
    }
    return false;
  }

  /**
   * Get a specific event
   */
  getEvent(eventId: string): CalendarEvent | null {
    const eventPath = this.getEventPath(eventId);
    if (!existsSync(eventPath)) {
      return null;
    }

    try {
      const data = readFileSync(eventPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`[FileCalendar] Failed to read event: ${eventId}`, error);
      return null;
    }
  }

  /**
   * List all events
   */
  listEvents(startDate?: Date, endDate?: Date): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      const files = readdirSync(this.calendarDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const eventPath = join(this.calendarDir, file);
          try {
            const data = readFileSync(eventPath, 'utf-8');
            const event = JSON.parse(data);

            // Parse dates
            event.startTime = new Date(event.startTime);
            event.endTime = new Date(event.endTime);
            event.created = new Date(event.created);
            event.updated = new Date(event.updated);

            // Filter by date range if provided
            if (startDate && event.endTime < startDate) continue;
            if (endDate && event.startTime > endDate) continue;

            events.push(event);
          } catch (error) {
            console.error(`[FileCalendar] Failed to parse event: ${file}`, error);
          }
        }
      }
    } catch (error) {
      console.error('[FileCalendar] Failed to list events', error);
    }

    // Sort by start time
    return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }

  /**
   * Create focus block
   */
  async createFocusBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    description?: string;
  }): Promise<CalendarEvent> {
    const endTime = new Date(params.startTime.getTime() + params.duration * 60000);

    return this.createEvent({
      summary: `🎯 Focus: ${params.title}`,
      description: params.description || 'Deep work session - minimize interruptions',
      startTime: params.startTime,
      endTime: endTime,
      type: 'focus',
    });
  }

  /**
   * Create health block
   */
  async createHealthBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    type: 'fitness' | 'meal' | 'mental_health';
  }): Promise<CalendarEvent> {
    const endTime = new Date(params.startTime.getTime() + params.duration * 60000);

    const emoji = params.type === 'fitness' ? '🏃' :
                 params.type === 'meal' ? '🍽️' :
                 params.type === 'mental_health' ? '🧘' : '📅';

    const description = params.type === 'fitness' ? 'Exercise and physical wellness' :
                       params.type === 'meal' ? 'Meal time and nutrition' :
                       params.type === 'mental_health' ? 'Mental health and wellness break' : 'Health block';

    return this.createEvent({
      summary: `${emoji} ${params.title}`,
      description: description,
      startTime: params.startTime,
      endTime: endTime,
      type: params.type,
    });
  }

  /**
   * Export to iCal format (.ics file)
   * Can be imported into iPhone Calendar, Google Calendar, etc.
   */
  exportToICS(events?: CalendarEvent[]): string {
    const eventsToExport = events || this.listEvents();

    let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenClaw Agent//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:OpenClaw Calendar
X-WR-TIMEZONE:America/New_York
X-WR-CALDESC:OpenClaw Agent Calendar
`;

    for (const event of eventsToExport) {
      const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const start = event.startTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const end = event.endTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      ics += `BEGIN:VEVENT
DTSTART:${start}
DTEND:${end}
DTSTAMP:${now}
CREATED:${now}
LAST-MODIFIED:${now}
UID:${event.id}@openclaw.agent
SUMMARY:${event.summary}
DESCRIPTION:${event.description || ''}
END:VEVENT
`;
    }

    ics += `END:VCALENDAR`;

    return ics;
  }

  /**
   * Save ICS file to disk
   */
  saveICSFile(filename: string = 'openclaw-calendar.ics'): string {
    const icsContent = this.exportToICS();
    const icsPath = join(process.cwd(), 'data', filename);

    writeFileSync(icsPath, icsContent);
    console.log(`[FileCalendar] Exported to: ${icsPath}`);

    return icsPath;
  }

  /**
   * Get calendar statistics
   */
  getStats() {
    const events = this.listEvents();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const upcoming = events.filter(e => e.startTime >= today && e.startTime <= weekFromNow);
    const byType = events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      total: events.length,
      upcoming: upcoming.length,
      byType,
      latest: events.length > 0 ? events[events.length - 1].summary : 'No events',
    };
  }

  /**
   * Save event to file
   */
  private saveEvent(event: CalendarEvent): void {
    const eventPath = this.getEventPath(event.id);
    writeFileSync(eventPath, JSON.stringify(event, null, 2));
  }
}

export const fileCalendarService = new FileCalendarService();