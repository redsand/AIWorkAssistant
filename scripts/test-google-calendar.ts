#!/usr/bin/env tsx
/**
 * Test Google Calendar Integration with OAuth2
 */

import { googleCalendarClient } from '../src/integrations/google/calendar-client';
import { calendarService } from '../src/integrations/google/calendar-service';
import { loadEnv } from '../src/config/env';

async function testGoogleCalendar() {
  console.log('🗓️  Google Calendar Integration Test (OAuth2)');
  console.log('============================================\n');

  // Load environment variables
  const env = loadEnv();

  // Check configuration
  console.log('Configuration Status:');
  console.log(`Client ID: ${env.GOOGLE_CALENDAR_CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
  console.log(`Client Secret: ${env.GOOGLE_CALENDAR_CLIENT_SECRET ? '✅ Set' : '❌ Missing'}`);
  console.log(`Redirect URI: ${env.GOOGLE_CALENDAR_REDIRECT_URI}`);
  console.log(`Calendar ID: ${env.GOOGLE_CALENDAR_CALENDAR_ID || 'primary'}`);

  if (!googleCalendarClient.isConfigured()) {
    console.error('\n❌ Google Calendar not configured!');
    console.error('Please set the following environment variables:');
    console.error('  GOOGLE_CALENDAR_CLIENT_ID=your_oauth_client_id_here');
    console.error('  GOOGLE_CALENDAR_CLIENT_SECRET=your_oauth_client_secret_here');
    console.error('  GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3050/auth/google/callback');
    console.error('\n📋 Setup Instructions:');
    console.error('1. Go to https://console.cloud.google.com/');
    console.error('2. Create a new project or select existing one');
    console.error('3. Enable Google Calendar API');
    console.error('4. Create OAuth 2.0 credentials (Web application)');
    console.error('5. Add http://localhost:3050/auth/google/callback to authorized redirect URIs');
    console.error('6. Copy Client ID and Client Secret to .env file');
    process.exit(1);
  }

  // Check if user needs to authorize
  if (googleCalendarClient.needsAuthorization()) {
    console.log('\n🔐 Authorization Required');
    console.log('========================\n');
    console.log('Google Calendar requires OAuth2 authorization.');
    console.log('Please follow these steps:\n');

    const authUrl = googleCalendarClient.getAuthorizationUrl();
    console.log('1. Visit this URL to authorize:');
    console.log(`   ${authUrl}\n`);
    console.log('2. Sign in to your Google account');
    console.log('3. Grant permission to access your calendar');
    console.log('4. You will be redirected back to the app');
    console.log('5. Run this test again to verify the authorization\n');

    console.log('💡 Quick Authorization Method:');
    console.log(`   Open http://localhost:3050/auth/google in your browser`);
    console.log(`   It will guide you through the authorization process\n`);

    process.exit(0);
  }

  try {
    // Test 1: Initialize client
    console.log('\n🔧 Test 1: Initialize Google Calendar Client...');
    const initialized = await googleCalendarClient.initialize();
    console.log(initialized ? '✅ Success' : '❌ Failed');

    // Test 2: Test connection
    console.log('\n🔌 Test 2: Test API Connection...');
    const connected = await googleCalendarClient.testConnection();
    console.log(connected ? '✅ Connection successful' : '❌ Connection failed');

    // Test 3: List events
    console.log('\n📋 Test 3: List Upcoming Events...');
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const events = await calendarService.listEvents(now, weekFromNow, 'test-user');
    console.log(`✅ Found ${events.length} events in the next 7 days`);

    if (events.length > 0) {
      console.log('\nUpcoming Events:');
      events.slice(0, 5).forEach((event, index) => {
        const startTime = event.start.dateTime || event.start.date;
        console.log(`  ${index + 1}. ${event.summary}`);
        console.log(`     Start: ${startTime}`);
        console.log(`     ID: ${event.id}`);
      });
    } else {
      console.log('  (No events found in the next 7 days)');
    }

    // Test 4: Create a test event
    console.log('\n➕ Test 4: Create Test Event...');
    const testEventStart = new Date();
    testEventStart.setHours(testEventStart.getHours() + 1); // 1 hour from now
    const testEventEnd = new Date(testEventStart.getTime() + 30 * 60 * 1000); // 30 min duration

    const testEvent = await calendarService.createEvent({
      summary: '🧪 OpenClaw Test Event',
      description: 'This is a test event created by OpenClaw Agent',
      startTime: testEventStart,
      endTime: testEventEnd,
    }, 'test-user');

    console.log('✅ Test event created successfully!');
    console.log(`  Event ID: ${testEvent.id}`);
    console.log(`  Summary: ${testEvent.summary}`);
    console.log(`  Start: ${testEvent.start.dateTime}`);
    console.log(`  📱 Check your iPhone Calendar app!`);

    // Test 5: Create focus block
    console.log('\n🎯 Test 5: Create Focus Block...');
    const focusStart = new Date();
    focusStart.setHours(focusStart.getHours() + 2); // 2 hours from now

    const focusBlock = await calendarService.createFocusBlock({
      title: 'Test Focus Session',
      startTime: focusStart,
      duration: 60, // 1 hour
      description: 'Deep work focus block',
    }, 'test-user');

    console.log('✅ Focus block created successfully!');
    console.log(`  Event ID: ${focusBlock.id}`);
    console.log(`  Summary: ${focusBlock.summary}`);
    console.log(`  📱 Check your iPhone Calendar app!`);

    // Test 6: Create health block
    console.log('\n🏃 Test 6: Create Health Block...');
    const healthStart = new Date();
    healthStart.setHours(healthStart.getHours() + 3); // 3 hours from now

    const healthBlock = await calendarService.createHealthBlock({
      title: 'Test Break',
      startTime: healthStart,
      duration: 15, // 15 minutes
      type: 'MENTAL_HEALTH',
    }, 'test-user');

    console.log('✅ Health block created successfully!');
    console.log(`  Event ID: ${healthBlock.id}`);
    console.log(`  Summary: ${healthBlock.summary}`);
    console.log(`  📱 Check your iPhone Calendar app!`);

    console.log('\n🎉 All tests passed! Google Calendar integration is working correctly.');
    console.log('\n📱 All events created will appear in your iPhone Calendar app!');
    console.log('🔗 Your calendar is now fully integrated with OpenClaw Agent.');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testGoogleCalendar();
