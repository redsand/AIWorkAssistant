/**
 * Google Calendar API Client with OAuth2 Authentication
 * Provides integration with Google Calendar API for calendar management
 */

import { google } from 'googleapis';
import { googleOAuthManager } from './oauth-manager';
import { env } from '../../config/env';

export interface GoogleCalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string; // ISO datetime
    date?: string; // All-day event
  };
  end: {
    dateTime?: string;
    date?: string;
  };
  location?: string;
  attendees?: Array<{
    email: string;
    responseStatus?: string;
  }>;
  created: string;
  updated: string;
}

export interface CreateEventParams {
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  attendees?: string[];
}

class GoogleCalendarClient {
  private authenticated = false;

  /**
   * Check if client is configured with OAuth2 credentials
   */
  isConfigured(): boolean {
    return !!env.GOOGLE_CALENDAR_CLIENT_ID &&
           !!env.GOOGLE_CALENDAR_CLIENT_SECRET &&
           googleOAuthManager.isAuthenticated();
  }

  /**
   * Initialize Google Calendar API client
   */
  async initialize(): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('[GoogleCalendar] Not configured - missing OAuth2 credentials or user not authorized');
      return false;
    }

    try {
      // Get authenticated OAuth2 client
      await googleOAuthManager.getAuthenticatedClient();
      this.authenticated = true;
      console.log('[GoogleCalendar] Successfully initialized with OAuth2');
      return true;
    } catch (error) {
      console.error('[GoogleCalendar] Initialization failed:', error);
      return false;
    }
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<boolean> {
    if (!this.authenticated) {
      await this.initialize();
    }

    if (!this.authenticated) {
      return false;
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      // Try to list calendar lists as a basic connection test
      await calendar.calendarList.list({
        auth: auth,
      });

      console.log('[GoogleCalendar] Connection test successful');
      return true;
    } catch (error) {
      console.error('[GoogleCalendar] Connection test failed:', error);
      return false;
    }
  }

  /**
   * List events from primary calendar
   */
  async listEvents(
    startDate: Date,
    endDate: Date,
    calendarId: string = 'primary'
  ): Promise<GoogleCalendarEvent[]> {
    if (!this.authenticated) {
      await this.initialize();
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      const response = await calendar.events.list({
        calendarId,
        auth: auth,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return (response.data.items || []) as GoogleCalendarEvent[];
    } catch (error) {
      console.error('[GoogleCalendar] Failed to list events:', error);
      throw error;
    }
  }

  /**
   * Create a new event
   */
  async createEvent(
    eventParams: CreateEventParams,
    calendarId: string = 'primary'
  ): Promise<GoogleCalendarEvent> {
    if (!this.authenticated) {
      await this.initialize();
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      const event = {
        summary: eventParams.summary,
        description: eventParams.description,
        start: {
          dateTime: eventParams.startTime.toISOString(),
        },
        end: {
          dateTime: eventParams.endTime.toISOString(),
        },
        location: eventParams.location,
        attendees: eventParams.attendees?.map(email => ({ email })),
      };

      const response = await calendar.events.insert({
        calendarId,
        auth: auth,
        requestBody: event,
      });

      if (!response.data) {
        throw new Error('No data returned from Google Calendar API');
      }

      console.log(`[GoogleCalendar] Created event: ${eventParams.summary}`);
      return response.data as GoogleCalendarEvent;
    } catch (error) {
      console.error('[GoogleCalendar] Failed to create event:', error);
      throw error;
    }
  }

  /**
   * Update an existing event
   */
  async updateEvent(
    eventId: string,
    eventParams: Partial<CreateEventParams>,
    calendarId: string = 'primary'
  ): Promise<GoogleCalendarEvent> {
    if (!this.authenticated) {
      await this.initialize();
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      const event: any = {};

      if (eventParams.summary) event.summary = eventParams.summary;
      if (eventParams.description) event.description = eventParams.description;
      if (eventParams.startTime) {
        event.start = { dateTime: eventParams.startTime.toISOString() };
      }
      if (eventParams.endTime) {
        event.end = { dateTime: eventParams.endTime.toISOString() };
      }
      if (eventParams.location) event.location = eventParams.location;
      if (eventParams.attendees) {
        event.attendees = eventParams.attendees.map(email => ({ email }));
      }

      const response = await calendar.events.patch({
        calendarId,
        eventId,
        auth: auth,
        requestBody: event,
      });

      if (!response.data) {
        throw new Error('No data returned from Google Calendar API');
      }

      console.log(`[GoogleCalendar] Updated event: ${eventId}`);
      return response.data as GoogleCalendarEvent;
    } catch (error) {
      console.error('[GoogleCalendar] Failed to update event:', error);
      throw error;
    }
  }

  /**
   * Delete an event
   */
  async deleteEvent(eventId: string, calendarId: string = 'primary'): Promise<boolean> {
    if (!this.authenticated) {
      await this.initialize();
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      await calendar.events.delete({
        calendarId,
        eventId,
        auth: auth,
      });

      console.log(`[GoogleCalendar] Deleted event: ${eventId}`);
      return true;
    } catch (error) {
      console.error('[GoogleCalendar] Failed to delete event:', error);
      throw error;
    }
  }

  /**
   * Get a specific event
   */
  async getEvent(
    eventId: string,
    calendarId: string = 'primary'
  ): Promise<GoogleCalendarEvent | null> {
    if (!this.authenticated) {
      await this.initialize();
    }

    try {
      const auth = await googleOAuthManager.getAuthenticatedClient();
      const calendar = google.calendar('v3');

      const response = await calendar.events.get({
        calendarId,
        eventId,
        auth: auth,
      });

      return response.data as GoogleCalendarEvent;
    } catch (error) {
      console.error('[GoogleCalendar] Failed to get event:', error);
      return null;
    }
  }

  /**
   * Get authorization URL for OAuth2 flow
   */
  getAuthorizationUrl(): string {
    return googleOAuthManager.getAuthUrl();
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<void> {
    await googleOAuthManager.exchangeCodeForTokens(code);
    this.authenticated = false; // Force re-initialization
    await this.initialize();
  }

  /**
   * Check if user needs to authorize
   */
  needsAuthorization(): boolean {
    return !googleOAuthManager.isAuthenticated();
  }
}

export const googleCalendarClient = new GoogleCalendarClient();
