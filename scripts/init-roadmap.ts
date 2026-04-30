#!/usr/bin/env tsx
/**
 * Initialize roadmap database with templates
 */

import { initializeTemplates } from '../src/roadmap/templates';
import { roadmapDatabase } from '../src/roadmap/database';

async function main() {
  console.log('Initializing roadmap database...');

  try {
    // Initialize templates
    console.log('\n=== Initializing Templates ===\n');
    initializeTemplates();

    // List all templates
    console.log('\n=== Templates in Database ===\n');
    const templates = roadmapDatabase.listTemplates();

    templates.forEach(template => {
      console.log(`📋 ${template.name}`);
      console.log(`   Type: ${template.type}`);
      console.log(`   Category: ${template.category}`);
      console.log(`   Description: ${template.description}`);

      const milestones = JSON.parse(template.milestones);
      const items = JSON.parse(template.items);

      console.log(`   Milestones: ${milestones.length}`);
      console.log(`   Items: ${items.length}`);
      console.log('');
    });

    console.log('✅ Roadmap database initialized successfully!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize roadmap database:', error);
    process.exit(1);
  }
}

main();
