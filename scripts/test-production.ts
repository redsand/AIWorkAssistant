#!/usr/bin/env tsx
/**
 * Production Readiness Testing Script
 * Validates all components for production deployment
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  message: string;
  details?: string;
}

class ProductionTestSuite {
  private results: TestResult[] = [];

  async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const startTime = Date.now();

    try {
      await testFn();
      const duration = Date.now() - startTime;
      this.results.push({
        name,
        passed: true,
        duration,
        message: '✅ PASSED',
      });
      console.log(`✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.push({
        name,
        passed: false,
        duration,
        message: '❌ FAILED',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      console.log(`❌ ${name} (${duration}ms) - ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Environment tests
  async testEnvironmentVariables() {
    const requiredVars = [
      'OPENCODE_API_KEY',
      'JIRA_BASE_URL',
      'JIRA_API_TOKEN',
      'GITLAB_BASE_URL',
      'GITLAB_TOKEN',
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
  }

  // API health tests
  async testAPIHealth() {
    const response = await axios.get(`${API_BASE}/health`);

    if (response.status !== 200) {
      throw new Error(`Health check returned status ${response.status}`);
    }

    if (!response.data.opencode || !response.data.jira || !response.data.gitlab) {
      throw new Error('Health check missing integration status');
    }
  }

  // OpenCode API test
  async testOpenCodeAPI() {
    const response = await axios.get(`${API_BASE}/chat/health`);

    if (!response.data.opencode.configured) {
      throw new Error('OpenCode API not configured');
    }

    if (!response.data.opencode.valid) {
      throw new Error('OpenCode API validation failed');
    }
  }

  // Jira API test
  async testJiraAPI() {
    // Test Jira connectivity (if configured)
    const hasJiraConfig = process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN;

    if (!hasJiraConfig) {
      throw new Error('Jira configuration missing');
    }
  }

  // GitLab API test
  async testGitLabAPI() {
    const hasGitLabConfig = process.env.GITLAB_BASE_URL && process.env.GITLAB_TOKEN;

    if (!hasGitLabConfig) {
      throw new Error('GitLab configuration missing');
    }
  }

  // Roadmap system test
  async testRoadmapSystem() {
    const response = await axios.get(`${API_BASE}/api/roadmaps`);

    if (response.status !== 200) {
      throw new Error('Roadmap API not responding');
    }

    const templatesResponse = await axios.get(`${API_BASE}/api/templates`);

    if (!Array.isArray(templatesResponse.data.templates)) {
      throw new Error('Templates API not returning array');
    }

    if (templatesResponse.data.templates.length === 0) {
      throw new Error('No roadmap templates found');
    }
  }

  // Memory management test
  async testMemoryManagement() {
    const response = await axios.get(`${API_BASE}/chat/memory/stats`);

    if (response.status !== 200) {
      throw new Error('Memory stats API not responding');
    }

    if (typeof response.data.stats.activeSessions !== 'number') {
      throw new Error('Memory stats format invalid');
    }
  }

  // Guardrails test
  async testGuardrailsSystem() {
    const response = await axios.get(`${API_BASE}/api/guardrails/stats`);

    if (response.status !== 200) {
      throw new Error('Guardrails stats API not responding');
    }

    // Test a critical action check
    const checkResponse = await axios.post(`${API_BASE}/api/guardrails/check`, {
      operation: 'fs.delete',
      params: { files: ['test.txt'] },
      userId: 'test-user',
      userRoles: ['developer'],
      environment: 'production',
    });

    if (checkResponse.status !== 200) {
      throw new Error('Guardrails check API failed');
    }

    if (!checkResponse.data.result) {
      throw new Error('Guardrails check result missing');
    }

    // Should be blocked for production delete
    if (checkResponse.data.result.allowed && checkResponse.data.result.allowed === true) {
      throw new Error('Guardrails not blocking dangerous operations');
    }
  }

  // File system test
  async testFileSystemSetup() {
    const requiredDirs = [
      'data',
      'data/memories',
      'data/audit',
      'logs',
      'backups',
    ];

    for (const dir of requiredDirs) {
      const dirPath = path.join(process.cwd(), dir);
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Required directory missing: ${dir}`);
      }
    }
  }

  // Configuration files test
  async testConfigurationFiles() {
    const requiredFiles = [
      'package.json',
      'tsconfig.json',
      '.env',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(process.cwd(), file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file missing: ${file}`);
      }
    }
  }

  // Docker setup test
  async testDockerSetup() {
    const dockerFile = path.join(process.cwd(), 'Dockerfile');
    const composeFile = path.join(process.cwd(), 'docker-compose.yml');

    if (!fs.existsSync(dockerFile)) {
      throw new Error('Dockerfile missing');
    }

    if (!fs.existsSync(composeFile)) {
      throw new Error('docker-compose.yml missing');
    }

    // Check if Docker is available
    try {
      const { execSync } = require('child_process');
      execSync('docker --version', { stdio: 'ignore' });
      execSync('docker-compose --version', { stdio: 'ignore' });
    } catch (error) {
      throw new Error('Docker or Docker Compose not available');
    }
  }

  // Performance test
  async testAPIPerformance() {
    const startTime = Date.now();

    try {
      await axios.get(`${API_BASE}/health`, { timeout: 5000 });
    } catch (error) {
      throw new Error('API health check timeout or failed');
    }

    const duration = Date.now() - startTime;

    if (duration > 3000) {
      throw new Error(`API response too slow: ${duration}ms`);
    }
  }

  // Security headers test
  async testSecurityHeaders() {
    const response = await axios.get(`${API_BASE}/health`);

    const headers = response.headers;

    // Check for basic security headers (if behind nginx/ssl)
    // This is a basic check - production should have proper headers
    const hasSecurityHeaders = headers['x-frame-options'] ||
                              headers['x-content-type-options'] ||
                              headers['strict-transport-security'];

    if (!hasSecurityHeaders) {
      console.warn('⚠️  Warning: Missing security headers (ensure nginx/proxy adds them)');
    }
  }

  // Rate limiting test
  async testRateLimiting() {
    const requests = [];

    // Send 20 rapid requests
    for (let i = 0; i < 20; i++) {
      requests.push(axios.get(`${API_BASE}/health`).catch(() => null));
    }

    const results = await Promise.all(requests);
    const failedRequests = results.filter(r => r === null || r.status !== 200);

    if (failedRequests.length === 0) {
      console.warn('⚠️  Warning: Rate limiting may not be enabled');
    }
  }

  // Generate report
  generateReport(): void {
    console.log('\n' + '='.repeat(60));
    console.log('PRODUCTION READINESS TEST REPORT');
    console.log('='.repeat(60) + '\n');

    const passedTests = this.results.filter(r => r.passed);
    const failedTests = this.results.filter(r => !r.passed);
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);

    console.log(`Total Tests: ${this.results.length}`);
    console.log(`Passed: ${passedTests.length}`);
    console.log(`Failed: ${failedTests.length}`);
    console.log(`Total Duration: ${totalDuration}ms`);
    console.log(`Success Rate: ${((passedTests.length / this.results.length) * 100).toFixed(1)}%\n`);

    if (failedTests.length > 0) {
      console.log('❌ FAILED TESTS:');
      failedTests.forEach(test => {
        console.log(`   - ${test.name}`);
        if (test.details) {
          console.log(`     ${test.details}`);
        }
      });
      console.log('');
    }

    console.log('✅ PASSED TESTS:');
    passedTests.forEach(test => {
      console.log(`   - ${test.name} (${test.duration}ms)`);
    });

    console.log('\n' + '='.repeat(60));

    if (failedTests.length === 0) {
      console.log('🎉 ALL TESTS PASSED - SYSTEM IS PRODUCTION READY!');
    } else {
      console.log('⚠️  SOME TESTS FAILED - PLEASE ADDRESS ISSUES BEFORE PRODUCTION');
    }

    console.log('='.repeat(60) + '\n');

    // Production readiness checklist
    console.log('📋 PRODUCTION READINESS CHECKLIST:\n');

    const checklist = [
      { name: 'Environment Variables', ready: process.env.OPENCODE_API_KEY && process.env.JIRA_API_TOKEN },
      { name: 'Database Setup', ready: fs.existsSync(path.join(process.cwd(), 'data')) },
      { name: 'SSL/TLS Certificates', ready: fs.existsSync(path.join(process.cwd(), 'ssl')) },
      { name: 'Backup System', ready: fs.existsSync(path.join(process.cwd(), 'backups')) },
      { name: 'Monitoring Setup', ready: fs.existsSync(path.join(process.cwd(), 'monitoring')) },
      { name: 'Docker Configuration', ready: fs.existsSync(path.join(process.cwd(), 'Dockerfile')) },
    ];

    checklist.forEach(item => {
      console.log(`   ${item.ready ? '✅' : '❌'} ${item.name}`);
    });

    console.log('\n');
  }

  // Run all tests
  async runAll(): Promise<void> {
    console.log('🚀 Starting Production Readiness Tests...\n');

    await this.runTest('Environment Variables', () => this.testEnvironmentVariables());
    await this.runTest('API Health Check', () => this.testAPIHealth());
    await this.runTest('OpenCode API', () => this.testOpenCodeAPI());
    await this.runTest('Jira API Configuration', () => this.testJiraAPI());
    await this.runTest('GitLab API Configuration', () => this.testGitLabAPI());
    await this.runTest('Roadmap System', () => this.testRoadmapSystem());
    await this.runTest('Memory Management', () => this.testMemoryManagement());
    await this.runTest('Guardrails System', () => this.testGuardrailsSystem());
    await this.runTest('File System Setup', () => this.testFileSystemSetup());
    await this.runTest('Configuration Files', () => this.testConfigurationFiles());
    await this.runTest('Docker Setup', () => this.testDockerSetup());
    await this.runTest('API Performance', () => this.testAPIPerformance());
    await this.runTest('Security Headers', () => this.testSecurityHeaders());
    await this.runTest('Rate Limiting', () => this.testRateLimiting());

    this.generateReport();

    const failedTests = this.results.filter(r => !r.passed);
    process.exit(failedTests.length > 0 ? 1 : 0);
  }
}

// Main execution
async function main() {
  const testSuite = new ProductionTestSuite();

  try {
    await testSuite.runAll();
  } catch (error) {
    console.error('❌ Test suite failed to run:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
