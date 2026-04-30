/**
 * Calendar service with Google Calendar integration and policy checks
 */

import { googleCalendarClient, GoogleCalendarEvent, CreateEventParams } from './calendar-client';
import { policyEngine } from '../../policy/engine';
import { Action } from '../../policy/types';
import { CALENDAR_EVENT_TYPES } from '../../config/constants';

class CalendarService {
  /**
   * Ensure calendar client is initialized
   */
  private async ensureInitialized() {
    if (!googleCalendarClient.isConfigured()) {
      throw new Error('Google Calendar not configured. Please set GOOGLE_CALENDAR_API_KEY and GOOGLE_CALENDAR_CLIENT_ID environment variables.');
    }

    if (!googleCalendarClient['authenticated']) {
      await googleCalendarClient.initialize();
    }
  }

  /**
   * List calendar events
   */
  async listEvents(startDate: Date, endDate: Date, userId: string): Promise<GoogleCalendarEvent[]> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.list',
      description: `List calendar events from ${startDate.toDateString()} to ${endDate.toDateString()}`,
      params: { startDate, endDate },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return googleCalendarClient.listEvents(startDate, endDate);
  }

  /**
   * Create calendar event
   */
  async createEvent(params: {
    summary: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    location?: string;
    attendees?: string[];
  }, userId: string): Promise<GoogleCalendarEvent> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.create',
      description: `Create calendar event: ${params.summary}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return googleCalendarClient.createEvent(params);
  }

  /**
   * Create focus block
   */
  async createFocusBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    description?: string;
  }, userId: string): Promise<GoogleCalendarEvent> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.focus_block.create',
      description: `Create focus block: ${params.title}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    const endTime = new Date(params.startTime.getTime() + params.duration * 60000);

    return googleCalendarClient.createEvent({
      summary: `🎯 Focus: ${params.title}`,
      description: params.description || 'Deep work session - minimize interruptions',
      startTime: params.startTime,
      endTime,
    });
  }

  /**
   * Create health/fitness/mental health block
   */
  async createHealthBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    type: keyof typeof CALENDAR_EVENT_TYPES;
  }, userId: string): Promise<GoogleCalendarEvent> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.health_block.create',
      description: `Create ${params.type} block: ${params.title}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    const endTime = new Date(params.startTime.getTime() + params.duration * 60000);

    // Add appropriate emoji based on type
    const emoji = params.type === 'FITNESS' ? '🏃' :
                  params.type === 'MEAL' ? '🍽️' :
                  params.type === 'MENTAL_HEALTH' ? '🧘' : '📅';

    const description = params.type === 'FITNESS' ? 'Exercise and physical wellness' :
                       params.type === 'MEAL' ? 'Meal time and nutrition' :
                       params.type === 'MENTAL_HEALTH' ? 'Mental health and wellness break' : 'Health block';

    return googleCalendarClient.createEvent({
      summary: `${emoji} ${params.title}`,
      description: description,
      startTime: params.startTime,
      endTime,
    });
  }

  /**
   * Update calendar event
   */
  async updateEvent(
    eventId: string,
    params: Partial<CreateEventParams>,
    userId: string
  ): Promise<GoogleCalendarEvent> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.update',
      description: `Update calendar event: ${eventId}`,
      params: { eventId, ...params },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return googleCalendarClient.updateEvent(eventId, params);
  }

  /**
   * Delete calendar event
   */
  async deleteEvent(eventId: string, userId: string): Promise<boolean> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.delete',
      description: `Delete calendar event: ${eventId}`,
      params: { eventId },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return googleCalendarClient.deleteEvent(eventId);
  }

  /**
   * Get specific event
   */
  async getEvent(eventId: string): Promise<GoogleCalendarEvent | null> {
    await this.ensureInitialized();

    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.read',
      description: `Get calendar event: ${eventId}`,
      params: { eventId },
      userId: 'system',
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return googleCalendarClient.getEvent(eventId);
  }
}

export const calendarService = new CalendarService();
