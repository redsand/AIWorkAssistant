#!/usr/bin/env tsx
/**
 * Roadmap System Tests
 */

import { roadmapDatabase } from '../src/roadmap/database';
import axios from 'axios';

const API_BASE = 'http://localhost:3000/api';

async function testDatabase() {
  console.log('\n=== Test 1: Database Operations ===\n');

  try {
    // Create a test roadmap
    console.log('Creating test roadmap...');
    const roadmap = roadmapDatabase.createRoadmap({
      name: 'Test Client Roadmap',
      type: 'client',
      status: 'active',
      startDate: new Date().toISOString(),
      endDate: null,
      jiraProjectKey: 'TEST',
      jiraProjectId: null,
      description: 'Test roadmap for validation',
      metadata: null,
    });

    console.log('✅ Roadmap created:', roadmap.id);

    // Create milestones
    console.log('\nCreating milestones...');
    const milestone1 = roadmapDatabase.createMilestone({
      roadmapId: roadmap.id,
      name: 'Discovery',
      description: 'Initial discovery phase',
      targetDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
      order: 0,
      jiraEpicKey: null,
    });

    const milestone2 = roadmapDatabase.createMilestone({
      roadmapId: roadmap.id,
      name: 'Implementation',
      description: 'Implementation phase',
      targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
      order: 1,
      jiraEpicKey: null,
    });

    console.log('✅ Milestones created:', milestone1.id, milestone2.id);

    // Create items
    console.log('\nCreating items...');
    const item1 = roadmapDatabase.createItem({
      milestoneId: milestone1.id,
      title: 'Test task 1',
      description: 'First test task',
      type: 'task',
      status: 'todo',
      priority: 'high',
      estimatedHours: 8,
      actualHours: null,
      assignee: null,
      jiraKey: null,
      order: 0,
    });

    const item2 = roadmapDatabase.createItem({
      milestoneId: milestone1.id,
      title: 'Test task 2',
      description: 'Second test task',
      type: 'feature',
      status: 'todo',
      priority: 'medium',
      estimatedHours: 16,
      actualHours: null,
      assignee: null,
      jiraKey: null,
      order: 1,
    });

    console.log('✅ Items created:', item1.id, item2.id);

    // Get roadmap with details
    console.log('\nRetrieving roadmap with details...');
    const retrievedRoadmap = roadmapDatabase.getRoadmap(roadmap.id);
    const milestones = roadmapDatabase.getMilestones(roadmap.id);
    const items = roadmapDatabase.getItems(milestone1.id);

    console.log('✅ Roadmap retrieved:', retrievedRoadmap?.name);
    console.log('✅ Milestones retrieved:', milestones.length);
    console.log('✅ Items retrieved:', items.length);

    // Update item
    console.log('\nUpdating item...');
    const updatedItem = roadmapDatabase.updateItem(item1.id, {
      status: 'in_progress',
      actualHours: 2,
    });

    console.log('✅ Item updated:', updatedItem?.status);

    // Cleanup
    console.log('\nCleaning up...');
    roadmapDatabase.deleteRoadmap(roadmap.id);
    console.log('✅ Test roadmap deleted');

    return true;
  } catch (error) {
    console.error('❌ Database test failed:', error);
    return false;
  }
}

async function testTemplates() {
  console.log('\n=== Test 2: Template System ===\n');

  try {
    const templates = roadmapDatabase.listTemplates();

    console.log(`✅ Found ${templates.length} templates`);

    templates.forEach(template => {
      console.log(`\n📋 ${template.name}`);
      console.log(`   Type: ${template.type}`);
      console.log(`   Category: ${template.category}`);

      const milestones = JSON.parse(template.milestones);
      const items = JSON.parse(template.items);

      console.log(`   Milestones: ${milestones.length}`);
      console.log(`   Items: ${items.length}`);
    });

    return true;
  } catch (error) {
    console.error('❌ Template test failed:', error);
    return false;
  }
}

async function testAPI() {
  console.log('\n=== Test 3: REST API ===\n');

  try {
    // Test health check
    console.log('Testing health check...');
    const healthResponse = await axios.get(`${API_BASE}/roadmap/health`);
    console.log('✅ Health check:', healthResponse.data.status);

    // List templates
    console.log('\nListing templates via API...');
    const templatesResponse = await axios.get(`${API_BASE}/templates`);
    console.log('✅ Templates retrieved:', templatesResponse.data.count);

    if (templatesResponse.data.templates.length > 0) {
      const template = templatesResponse.data.templates[0];
      console.log(`\nCreating roadmap from template: ${template.name}...`);

      // Create roadmap from template
      const createResponse = await axios.post(`${API_BASE}/templates/${template.id}/create-roadmap`, {
        name: 'API Test Roadmap',
        startDate: new Date().toISOString(),
        description: 'Roadmap created via API',
      });

      console.log('✅ Roadmap created from template:', createResponse.data.roadmap.id);

      const roadmapId = createResponse.data.roadmap.id;

      // Get roadmap details
      console.log('\nRetrieving roadmap details...');
      const roadmapResponse = await axios.get(`${API_BASE}/roadmaps/${roadmapId}`);
      console.log('✅ Roadmap retrieved:', roadmapResponse.data.roadmap.name);
      console.log('   Milestones:', roadmapResponse.data.roadmap.milestones.length);

      // Update milestone
      if (roadmapResponse.data.roadmap.milestones.length > 0) {
        const milestoneId = roadmapResponse.data.roadmap.milestones[0].id;
        console.log('\nUpdating milestone status...');

        await axios.patch(`${API_BASE}/milestones/${milestoneId}`, {
          status: 'in_progress',
        });

        console.log('✅ Milestone updated');
      }

      // Cleanup
      console.log('\nCleaning up test roadmap...');
      await axios.delete(`${API_BASE}/roadmaps/${roadmapId}`);
      console.log('✅ Test roadmap deleted');
    }

    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('❌ API test failed:', error.response?.data || error.message);
    } else {
      console.error('❌ API test failed:', error);
    }
    return false;
  }
}

async function main() {
  console.log('Roadmap System Tests');
  console.log('====================\n');

  const dbTest = await testDatabase();
  const templateTest = await testTemplates();
  const apiTest = await testAPI();

  console.log('\n=== Test Summary ===\n');
  console.log('Database Operations:', dbTest ? '✅' : '❌');
  console.log('Template System:', templateTest ? '✅' : '❌');
  console.log('REST API:', apiTest ? '✅' : '❌');

  if (dbTest && templateTest && apiTest) {
    console.log('\n🎉 All roadmap system tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
