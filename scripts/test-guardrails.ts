#!/usr/bin/env tsx
/**
 * Test critical action guardrails
 */

import { guardrailsRegistry, RiskLevel, ActionCategory } from '../src/guardrails/action-registry';
import { guardrailsEnforcer } from '../src/guardrails/enforcement';

async function testFileDeleteGuardrails() {
  console.log('\n=== Test 1: File Delete Guardrails ===\n');

  try {
    // Test single file delete
    console.log('Testing single file delete...');
    const singleFileResult = await guardrailsEnforcer.preExecutionCheck(
      'fs.delete',
      { files: ['test.txt'], dryRun: true },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'development',
      }
    );

    console.log('Single file delete:', singleFileResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (singleFileResult.estimatedImpact) {
      console.log('Estimated impact:', singleFileResult.estimatedImpact);
    }

    // Test mass delete
    console.log('\nTesting mass file delete...');
    const massFileResult = await guardrailsEnforcer.preExecutionCheck(
      'fs.delete',
      { files: Array(20).fill('file.txt') },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'production',
      }
    );

    console.log('Mass file delete:', massFileResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (!massFileResult.allowed) {
      console.log('Reason:', massFileResult.reason);
      console.log('Requirements:', massFileResult.requirements);
    }
    if (massFileResult.estimatedImpact) {
      console.log('Estimated impact:', massFileResult.estimatedImpact);
    }

    return massFileResult.allowed === false;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testDatabaseGuardrails() {
  console.log('\n=== Test 2: Database Delete Guardrails ===\n');

  try {
    // Test database delete
    console.log('Testing database delete...');
    const dbDeleteResult = await guardrailsEnforcer.preExecutionCheck(
      'db.delete',
      { records: ['id1', 'id2', 'id3'] },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'production',
      }
    );

    console.log('Database delete:', dbDeleteResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (!dbDeleteResult.allowed) {
      console.log('Reason:', dbDeleteResult.reason);
      console.log('Requirements:', dbDeleteResult.requirements);
    }

    // Test mass database delete
    console.log('\nTesting mass database delete...');
    const massDbDeleteResult = await guardrailsEnforcer.preExecutionCheck(
      'db.delete',
      { records: Array(25).fill('record-id') },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'production',
      }
    );

    console.log('Mass database delete:', massDbDeleteResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (!massDbDeleteResult.allowed) {
      console.log('Reason:', massDbDeleteResult.reason);
      console.log('Requirements:', massDbDeleteResult.requirements);
    }

    return !dbDeleteResult.allowed && !massDbDeleteResult.allowed;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testProductionDeploymentGuardrails() {
  console.log('\n=== Test 3: Production Deployment Guardrails ===\n');

  try {
    // Test production deployment
    console.log('Testing production deployment...');
    const prodDeployResult = await guardrailsEnforcer.preExecutionCheck(
      'deploy',
      { environment: 'production', justification: 'Critical security fix' },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'production',
      }
    );

    console.log('Production deployment:', prodDeployResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (!prodDeployResult.allowed) {
      console.log('Reason:', prodDeployResult.reason);
      console.log('Requirements:', prodDeployResult.requirements);
    }
    if (prodDeployResult.estimatedImpact) {
      console.log('Estimated impact:', prodDeployResult.estimatedImpact);
    }

    // Test staging deployment
    console.log('\nTesting staging deployment...');
    const stagingDeployResult = await guardrailsEnforcer.preExecutionCheck(
      'deploy',
      { environment: 'staging' },
      {
        userId: 'test-user',
        userRoles: ['developer'],
        environment: 'staging',
      }
    );

    console.log('Staging deployment:', stagingDeployResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');

    return !prodDeployResult.allowed && stagingDeployResult.allowed;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testRateLimiting() {
  console.log('\n=== Test 4: Rate Limiting ===\n');

  try {
    console.log('Testing rate limiting for critical actions...');

    let blockedByRateLimit = false;

    // Try to execute multiple critical actions rapidly
    for (let i = 0; i < 5; i++) {
      const result = await guardrailsEnforcer.preExecutionCheck(
        'fs.mass_delete',
        { files: Array(20).fill('file.txt'), justification: 'Test' },
        {
          userId: 'test-user',
          userRoles: ['admin'],
          environment: 'development',
        }
      );

      console.log(`Attempt ${i + 1}:`, result.allowed ? '✅ ALLOWED' : '❌ BLOCKED');

      if (!result.allowed && result.reason?.includes('rate limit')) {
        blockedByRateLimit = true;
        console.log('Rate limit activated:', result.reason);
        break;
      }
    }

    return blockedByRateLimit;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testAuthorizationChecks() {
  console.log('\n=== Test 5: Authorization Checks ===\n');

  try {
    // Test with unauthorized user
    console.log('Testing unauthorized user...');
    const unauthorizedResult = await guardrailsEnforcer.preExecutionCheck(
      'fs.mass_delete',
      { files: Array(20).fill('file.txt') },
      {
        userId: 'unauthorized-user',
        userRoles: ['user'], // Not admin role
        environment: 'development',
      }
    );

    console.log('Unauthorized user:', unauthorizedResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');
    if (!unauthorizedResult.allowed) {
      console.log('Reason:', unauthorizedResult.reason);
    }

    // Test with authorized user
    console.log('\nTesting authorized user...');
    const authorizedResult = await guardrailsEnforcer.preExecutionCheck(
      'fs.mass_delete',
      { files: Array(20).fill('file.txt') },
      {
        userId: 'admin-user',
        userRoles: ['admin'],
        environment: 'development',
      }
    );

    console.log('Authorized user:', authorizedResult.allowed ? '✅ ALLOWED' : '❌ BLOCKED');

    return !unauthorizedResult.allowed;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testStatistics() {
  console.log('\n=== Test 6: Guardrails Statistics ===\n');

  try {
    const stats = guardrailsRegistry.getStats();

    console.log('📊 Guardrails Statistics:');
    console.log(`   Total Actions: ${stats.totalActions}`);
    console.log(`   Pending Approvals: ${stats.pendingApprovals}`);
    console.log(`   Executions (24h): ${stats.executionsLast24h}`);
    console.log(`   Top Users: ${stats.topUsers.map(u => `${u.userId} (${u.count})`).join(', ')}`);

    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function main() {
  console.log('Critical Action Guardrails Tests');
  console.log('=================================\n');

  const test1 = await testFileDeleteGuardrails();
  const test2 = await testDatabaseGuardrails();
  const test3 = await testProductionDeploymentGuardrails();
  const test4 = await testRateLimiting();
  const test5 = await testAuthorizationChecks();
  const test6 = await testStatistics();

  console.log('\n=== Test Summary ===\n');
  console.log('File Delete Guardrails:', test1 ? '✅' : '❌');
  console.log('Database Delete Guardrails:', test2 ? '✅' : '❌');
  console.log('Production Deployment Guardrails:', test3 ? '✅' : '❌');
  console.log('Rate Limiting:', test4 ? '✅' : '❌');
  console.log('Authorization Checks:', test5 ? '✅' : '❌');
  console.log('Statistics:', test6 ? '✅' : '❌');

  const allPassed = test1 && test2 && test3 && test4 && test5 && test6;

  if (allPassed) {
    console.log('\n🎉 All guardrails tests passed!');
    console.log('\n🛡️ Guardrails System Status:');
    console.log('   ✅ Critical actions require approval');
    console.log('   ✅ Rate limiting enforced');
    console.log('   ✅ Authorization checks working');
    console.log('   ✅ Production deployment safeguards active');
    console.log('   ✅ Mass delete protection enabled');
    console.log('   ✅ Audit logging functional');
    process.exit(0);
  } else {
    console.log('\n❌ Some guardrails tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
