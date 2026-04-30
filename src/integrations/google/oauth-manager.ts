/**
 * Google OAuth2 Manager
 * Handles OAuth2 authentication flow for Google Calendar API
 */

import { google } from 'googleapis';
import { env } from '../../config/env';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface OAuth2Tokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope: string;
}

class GoogleOAuthManager {
  private tokensPath: string;
  private oauth2Client: any;
  private tokens: OAuth2Tokens | null = null;

  constructor() {
    this.tokensPath = join(process.cwd(), 'data', 'google-tokens.json');
    this.initializeOAuth2Client();
    this.loadTokens();
  }

  /**
   * Initialize OAuth2 client
   */
  private initializeOAuth2Client() {
    this.oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_CALENDAR_CLIENT_ID,
      env.GOOGLE_CALENDAR_CLIENT_SECRET,
      env.GOOGLE_CALENDAR_REDIRECT_URI
    );
  }

  /**
   * Load stored tokens from disk
   */
  private loadTokens() {
    try {
      if (existsSync(this.tokensPath)) {
        const tokenData = readFileSync(this.tokensPath, 'utf-8');
        this.tokens = JSON.parse(tokenData);

        // Set credentials on OAuth2 client
        this.oauth2Client.setCredentials(this.tokens);

        console.log('[GoogleOAuth] Loaded existing tokens');
      }
    } catch (error) {
      console.error('[GoogleOAuth] Failed to load tokens:', error);
      this.tokens = null;
    }
  }

  /**
   * Save tokens to disk
   */
  private saveTokens() {
    try {
      // Ensure data directory exists
      const dataDir = join(process.cwd(), 'data');
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      writeFileSync(this.tokensPath, JSON.stringify(this.tokens, null, 2));
      console.log('[GoogleOAuth] Tokens saved successfully');
    } catch (error) {
      console.error('[GoogleOAuth] Failed to save tokens:', error);
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.tokens && !!this.tokens.access_token;
  }

  /**
   * Get authorization URL
   */
  getAuthUrl(state?: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: state || 'google_oauth_state',
      prompt: 'consent'
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<OAuth2Tokens> {
    try {
      const { tokens } = await this.oauth2Client.getAccessToken(code);

      if (!tokens) {
        throw new Error('Failed to get access token');
      }

      this.tokens = {
        access_token: tokens.access_token as string,
        refresh_token: tokens.refresh_token as string,
        expiry_date: tokens.expiry_date as number,
        scope: tokens.scope as string
      };

      this.saveTokens();
      console.log('[GoogleOAuth] Successfully exchanged code for tokens');

      return this.tokens;
    } catch (error) {
      console.error('[GoogleOAuth] Failed to exchange code for tokens:', error);
      throw error;
    }
  }

  /**
   * Get authenticated OAuth2 client (refreshes tokens if needed)
   */
  async getAuthenticatedClient(): Promise<any> {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated. Please authorize first.');
    }

    // Check if token needs refresh
    if (this.tokens!.expiry_date && Date.now() >= this.tokens!.expiry_date) {
      console.log('[GoogleOAuth] Token expired, refreshing...');
      await this.refreshTokens();
    }

    return this.oauth2Client;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshTokens(): Promise<void> {
    if (!this.tokens || !this.tokens.refresh_token) {
      throw new Error('No refresh token available');
    }

    try {
      this.oauth2Client.setCredentials({
        refresh_token: this.tokens.refresh_token
      });

      const { credentials } = await this.oauth2Client.refreshAccessToken();

      if (!credentials) {
        throw new Error('Failed to refresh token');
      }

      this.tokens = {
        access_token: credentials.access_token as string,
        refresh_token: credentials.refresh_token as string || this.tokens.refresh_token,
        expiry_date: credentials.expiry_date as number,
        scope: credentials.scope as string || this.tokens.scope
      };

      this.saveTokens();
      console.log('[GoogleOAuth] Successfully refreshed tokens');
    } catch (error) {
      console.error('[GoogleOAuth] Failed to refresh tokens:', error);
      throw error;
    }
  }

  /**
   * Clear stored tokens (logout)
   */
  clearTokens(): void {
    this.tokens = null;
    try {
      if (existsSync(this.tokensPath)) {
        // Delete the token file
        require('fs').unlinkSync(this.tokensPath);
      }
      console.log('[GoogleOAuth] Tokens cleared');
    } catch (error) {
      console.error('[GoogleOAuth] Failed to clear tokens:', error);
    }
  }

  /**
   * Get current access token
   */
  getAccessToken(): string | null {
    return this.tokens?.access_token || null;
  }
}

export const googleOAuthManager = new GoogleOAuthManager();
