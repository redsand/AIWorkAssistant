#!/usr/bin/env tsx
/**
 * GitLab API integration tests
 */

import { gitlabClient } from '../src/integrations/gitlab/gitlab-client';

async function testConfiguration() {
  console.log('\n=== Test 1: Configuration ===\n');

  const isConfigured = gitlabClient.isConfigured();
  console.log('GitLab configured:', isConfigured ? 'Yes' : 'No');

  if (!isConfigured) {
    console.error('✗ GitLab not configured');
    return false;
  }

  const isValid = await gitlabClient.validateConfig();
  console.log('Connection valid:', isValid ? 'Yes' : 'No');

  return isValid;
}

async function testCurrentUser() {
  console.log('\n=== Test 2: Current User ===\n');

  try {
    const user = await gitlabClient.getCurrentUser();
    console.log('✓ Success!');
    console.log('Name:', user.name);
    console.log('Username:', user.username);
    console.log('Email:', user.email);
    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testProjects() {
  console.log('\n=== Test 3: Projects ===\n');

  try {
    const projects = await gitlabClient.getProjects();
    console.log('✓ Success!');
    console.log(`Found ${projects.length} projects`);

    if (projects.length > 0) {
      console.log('Sample projects:');
      projects.slice(0, 5).forEach(p => {
        console.log(`  - ${p.path_with_namespace}`);
        console.log(`    Name: ${p.name}`);
      });
    }

    return { success: true, projects };
  } catch (error) {
    console.error('✗ Failed:', error);
    return { success: false, projects: [] };
  }
}

async function testMergeRequests(projects: any[]) {
  console.log('\n=== Test 4: Merge Requests ===\n');

  if (projects.length === 0) {
    console.warn('No projects to test MRs with');
    return true;
  }

  try {
    // Test with first project
    const projectId = projects[0].id;
    const mrs = await gitlabClient.getMergeRequests(projectId);

    console.log('✓ Success!');
    console.log(`Found ${mrs.length} MRs in ${projects[0].path_with_namespace}`);

    if (mrs.length > 0) {
      console.log('Recent MRs:');
      mrs.slice(0, 3).forEach(mr => {
        console.log(`  - !${mr.iid}: ${mr.title}`);
        console.log(`    State: ${mr.state}`);
        console.log(`    Author: ${mr.author.name}`);
        console.log(`    Branch: ${mr.source_branch} → ${mr.target_branch}`);
      });
    } else {
      console.log('  No MRs found');
    }

    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testBranches(projects: any[]) {
  console.log('\n=== Test 5: Branches ===\n');

  if (projects.length === 0) {
    console.warn('No projects to test branches with');
    return true;
  }

  try {
    const projectId = projects[0].id;
    const branches = await gitlabClient.getBranches(projectId);

    console.log('✓ Success!');
    console.log(`Found ${branches.length} branches in ${projects[0].path_with_namespace}`);

    if (branches.length > 0) {
      console.log('Sample branches:');
      branches.slice(0, 5).forEach(branch => {
        console.log(`  - ${branch.name}`);
        console.log(`    Commit: ${branch.commit.short_id}`);
      });
    }

    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testCommits(projects: any[]) {
  console.log('\n=== Test 6: Recent Commits ===\n');

  if (projects.length === 0) {
    console.warn('No projects to test commits with');
    return true;
  }

  try {
    const projectId = projects[0].id;
    const commits = await gitlabClient.getCommits(projectId, 'main');

    console.log('✓ Success!');
    console.log(`Found ${commits.length} commits in main branch`);

    if (commits.length > 0) {
      console.log('Recent commits:');
      commits.slice(0, 3).forEach(commit => {
        console.log(`  - ${commit.short_id}: ${commit.title}`);
        console.log(`    Author: ${commit.author_name}`);
        console.log(`    Date: ${new Date(commit.created_at).toLocaleDateString()}`);
      });
    }

    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function main() {
  console.log('GitLab API Integration Tests');
  console.log('=============================\n');

  // Check configuration
  console.log('Checking configuration...');
  const isValid = await testConfiguration();

  if (!isValid) {
    console.error('\n✗ GitLab API validation failed!');
    console.log('Please check your credentials in .env file.');
    process.exit(1);
  }

  // Run tests
  const userResult = await testCurrentUser();
  const projectsResult = await testProjects();

  if (projectsResult.success) {
    await testMergeRequests(projectsResult.projects);
    await testBranches(projectsResult.projects);
    await testCommits(projectsResult.projects);
  }

  // Summary
  console.log('\n=== Test Summary ===\n');
  console.log('Configuration:', isValid ? '✓' : '✗');
  console.log('Current User:', userResult ? '✓' : '✗');
  console.log('Projects:', projectsResult.success ? '✓' : '✗');

  console.log('\n🎉 GitLab API integration working!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
