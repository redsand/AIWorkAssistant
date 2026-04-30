/**
 * Calendar service with policy checks
 * TODO: Implement actual calendar operations
 */

import { graphClient } from './graph-client';
import { policyEngine } from '../../policy/engine';
import { Action } from '../../policy/types';
import { CALENDAR_EVENT_TYPES } from '../../config/constants';

class CalendarService {
  /**
   * List calendar events
   */
  async listEvents(startDate: Date, endDate: Date, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.list',
      description: `List calendar events from ${startDate} to ${endDate}`,
      params: { startDate, endDate },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return graphClient.listEvents(startDate, endDate);
  }

  /**
   * Create focus block
   */
  async createFocusBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    description?: string;
  }, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.focus_block.create',
      description: `Create focus block: ${params.title}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(action, decision);
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    const event = {
      subject: params.title,
      body: params.description ? {
        content: params.description,
        contentType: 'Text',
      } : undefined,
      start: {
        dateTime: params.startTime.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: new Date(params.startTime.getTime() + params.duration * 60000).toISOString(),
        timeZone: 'UTC',
      },
    };

    return graphClient.createEvent(event);
  }

  /**
   * Create health block (fitness, meal, mental health)
   */
  async createHealthBlock(params: {
    title: string;
    startTime: Date;
    duration: number;
    type: keyof typeof CALENDAR_EVENT_TYPES;
  }, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.health_block.create',
      description: `Create ${params.type} block: ${params.title}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(action, decision);
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    const event = {
      subject: params.title,
      start: {
        dateTime: params.startTime.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: new Date(params.startTime.getTime() + params.duration * 60000).toISOString(),
        timeZone: 'UTC',
      },
    };

    return graphClient.createEvent(event);
  }

  /**
   * Move meeting with attendees
   */
  async moveMeeting(id: string, newStartTime: Date, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.move_with_attendees',
      description: `Move meeting ${id} to ${newStartTime}`,
      params: { id, newStartTime },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(action, decision);
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    // Check if event has attendees
    const event = await graphClient.listEvents(newStartTime, newStartTime);
    const targetEvent = event.find(e => e.id === id);

    if (targetEvent && targetEvent.attendees && targetEvent.attendees.length > 1) {
      // This is a meeting with attendees
      const approval = await policyEngine.createApprovalRequest(action, decision);
      return { approval, decision };
    }

    // Safe to move
    return graphClient.updateEvent(id, {
      start: {
        dateTime: newStartTime.toISOString(),
        timeZone: 'UTC',
      },
    });
  }

  /**
   * Delete calendar event
   */
  async deleteEvent(id: string, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: 'calendar.event.delete',
      description: `Delete calendar event ${id}`,
      params: { id },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(action, decision);
      return { approval, decision };
    }

    return graphClient.deleteEvent(id);
  }
}

export const calendarService = new CalendarService();
