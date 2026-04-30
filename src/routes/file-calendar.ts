/**
 * File-based Calendar API Routes
 * Simple calendar management without external dependencies
 */

import { FastifyInstance } from 'fastify';
import { fileCalendarService } from '../integrations/file/calendar-service';

export async function fileCalendarRoutes(fastify: FastifyInstance) {
  /**
   * List all events
   */
  fastify.get('/calendar/events', async (request, reply) => {
    try {
      const { startDate, endDate } = request.query as {
        startDate?: string;
        endDate?: string;
      };

      const events = fileCalendarService.listEvents(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      );

      return {
        success: true,
        events,
        count: events.length
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to list events'
      };
    }
  });

  /**
   * Get calendar statistics
   */
  fastify.get('/calendar/stats', async (request, reply) => {
    try {
      const stats = fileCalendarService.getStats();

      return {
        success: true,
        stats
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to get calendar stats'
      };
    }
  });

  /**
   * Create a new event
   */
  fastify.post('/calendar/events', async (request, reply) => {
    try {
      const body = request.body as {
        summary: string;
        description?: string;
        startTime: string;
        endTime: string;
        location?: string;
        type?: 'meeting' | 'focus' | 'fitness' | 'meal' | 'mental_health' | 'other';
      };

      const event = await fileCalendarService.createEvent({
        summary: body.summary,
        description: body.description,
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        location: body.location,
        type: body.type,
      });

      return {
        success: true,
        event,
        message: 'Event created successfully'
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to create event'
      };
    }
  });

  /**
   * Create focus block
   */
  fastify.post('/calendar/focus-blocks', async (request, reply) => {
    try {
      const body = request.body as {
        title: string;
        startTime: string;
        duration: number;
        description?: string;
      };

      const event = await fileCalendarService.createFocusBlock({
        title: body.title,
        startTime: new Date(body.startTime),
        duration: body.duration,
        description: body.description,
      });

      return {
        success: true,
        event,
        message: 'Focus block created successfully'
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to create focus block'
      };
    }
  });

  /**
   * Create health block
   */
  fastify.post('/calendar/health-blocks', async (request, reply) => {
    try {
      const body = request.body as {
        title: string;
        startTime: string;
        duration: number;
        type: 'fitness' | 'meal' | 'mental_health';
      };

      const event = await fileCalendarService.createHealthBlock({
        title: body.title,
        startTime: new Date(body.startTime),
        duration: body.duration,
        type: body.type,
      });

      return {
        success: true,
        event,
        message: 'Health block created successfully'
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to create health block'
      };
    }
  });

  /**
   * Export calendar to ICS format
   */
  fastify.get('/calendar/export/ics', async (request, reply) => {
    try {
      const icsContent = fileCalendarService.exportToICS();

      reply.type('text/calendar').send(icsContent);
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to export calendar'
      };
    }
  });

  /**
   * Update an event
   */
  fastify.patch('/calendar/events/:eventId', async (request, reply) => {
    try {
      const { eventId } = request.params as { eventId: string };
      const body = request.body as Partial<{
        summary: string;
        description: string;
        startTime: string;
        endTime: string;
        location: string;
        type: 'meeting' | 'focus' | 'fitness' | 'meal' | 'mental_health' | 'other';
      }>;

      const event = await fileCalendarService.updateEvent(eventId, {
        summary: body.summary,
        description: body.description,
        startTime: body.startTime ? new Date(body.startTime) : undefined,
        endTime: body.endTime ? new Date(body.endTime) : undefined,
        location: body.location,
        type: body.type,
      });

      return {
        success: true,
        event,
        message: 'Event updated successfully'
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to update event'
      };
    }
  });

  /**
   * Delete an event
   */
  fastify.delete('/calendar/events/:eventId', async (request, reply) => {
    try {
      const { eventId } = request.params as { eventId: string };
      const deleted = await fileCalendarService.deleteEvent(eventId);

      if (!deleted) {
        reply.code(404);
        return {
          success: false,
          error: 'Event not found'
        };
      }

      return {
        success: true,
        message: 'Event deleted successfully'
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: 'Failed to delete event'
      };
    }
  });
}
