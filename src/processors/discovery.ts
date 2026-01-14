import { Job } from 'bull';
import { Client } from '@microsoft/microsoft-graph-client';
import { supabase, migrationQueue } from '../index';
import { logger } from '../utils/logger';

interface DiscoveryJobData {
  migrationJobId: string;
  orgId: string;
  accessToken: string;
  provider: 'microsoft365' | 'google_workspace';
}

export async function discoveryProcessor(job: Job<DiscoveryJobData>) {
  const { migrationJobId, orgId, accessToken, provider } = job.data;

  logger.info(`🔍 Starting discovery for migration ${migrationJobId}`);

  try {
    // Initialize Microsoft Graph client
    const client = Client.init({
      authProvider: (done) => done(null, accessToken),
    });

    // Update status to running
    await supabase
      .from('migration_jobs')
      .update({
        phase: 'discovery',
        status: 'running',
      })
      .eq('id', migrationJobId);

    // Step 1: Get organization info (10%)
    job.progress(10);
    const org = await client.api('/organization').get();
    const orgInfo = org.value[0];
    logger.info('Fetched organization info', {
      orgName: orgInfo.displayName,
      verifiedDomains: orgInfo.verifiedDomains?.length || 0,
    });

    // Step 2: Get all users with pagination (30%)
    job.progress(30);
    let allUsers: any[] = [];
    let nextLink = '/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department';
    
    while (nextLink) {
      const response = await client.api(nextLink).get();
      allUsers = allUsers.concat(response.value);
      nextLink = response['@odata.nextLink'];
      
      if (allUsers.length % 100 === 0) {
        logger.info(`Fetched ${allUsers.length} users so far...`);
      }
    }

    logger.info(`✅ Total users discovered: ${allUsers.length}`);

    // Step 3: Get mailbox message counts (parallel, limited concurrency)
    job.progress(50);
    const mailboxStats = [];
    const batchSize = 10;
    
    for (let i = 0; i < allUsers.length; i += batchSize) {
      const batch = allUsers.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (user) => {
          try {
            const count = await client
              .api(`/users/${user.id}/messages/$count`)
              .get();
            return {
              userId: user.id,
              email: user.mail || user.userPrincipalName,
              messageCount: count,
            };
          } catch (err) {
            logger.warn(`Failed to get message count for ${user.mail}`, {
              error: err instanceof Error ? err.message : 'Unknown error',
            });
            return {
              userId: user.id,
              email: user.mail || user.userPrincipalName,
              messageCount: 0,
            };
          }
        })
      );
      mailboxStats.push(...batchResults);
      
      // Update progress incrementally
      const progress = 50 + ((i + batchSize) / allUsers.length) * 20;
      job.progress(Math.min(70, progress));
    }

    const totalMessages = mailboxStats.reduce((sum, m) => sum + m.messageCount, 0);
    const estimatedBytes = totalMessages * 50000; // 50KB per message avg
    const estimatedMinutes = Math.ceil(totalMessages / 1000); // 1000 msg/min

    logger.info(`📊 Discovery statistics`, {
      users: allUsers.length,
      totalMessages,
      estimatedBytes: (estimatedBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      estimatedMinutes: estimatedMinutes + ' minutes',
    });

    // Step 4: Save discovery results to database (80%)
    job.progress(80);
    await supabase
      .from('migration_jobs')
      .update({
        users_count: allUsers.length,
        mailboxes_count: allUsers.length,
        total_size_bytes: estimatedBytes,
        estimated_duration_minutes: estimatedMinutes,
        phase: 'staging',
        status: 'pending',
      })
      .eq('id', migrationJobId);

    // Step 5: Create user sync state records (90%)
    job.progress(90);
    const userStates = allUsers.map((user) => ({
      migration_job_id: migrationJobId,
      user_email: user.mail || user.userPrincipalName,
      provider_user_id: user.id,
      status: 'pending',
    }));

    const { data: createdStates, error: statesError } = await supabase
      .from('user_sync_state')
      .insert(userStates)
      .select();

    if (statesError) {
      throw new Error(`Failed to create user sync states: ${statesError.message}`);
    }

    // Step 6: Queue mail sync jobs for each user (95%)
    job.progress(95);
    if (createdStates) {
      for (const state of createdStates) {
        await migrationQueue.add('mail-sync', {
          userSyncStateId: state.id,
          userId: state.provider_user_id,
          migrationJobId,
          accessToken,
        }, {
          delay: 1000, // Stagger jobs by 1 second
        });
      }
    }

    job.progress(100);

    logger.info(`✅ Discovery complete for migration ${migrationJobId}`, {
      usersQueued: createdStates?.length || 0,
    });

    return {
      usersCount: allUsers.length,
      totalMessages,
      estimatedBytes,
      estimatedMinutes,
      usersQueued: createdStates?.length || 0,
    };
  } catch (error) {
    logger.error(`❌ Discovery failed for migration ${migrationJobId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });

    await supabase
      .from('migration_jobs')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', migrationJobId);

    throw error;
  }
}
