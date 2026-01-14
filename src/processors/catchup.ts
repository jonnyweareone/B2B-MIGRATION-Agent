import { Job } from 'bull';
import { supabase, migrationQueue } from '../index';
import { logger } from '../utils/logger';

interface CatchupJobData {
  migrationJobId: string;
  accessToken: string;
}

export async function catchupProcessor(job: Job<CatchupJobData>) {
  const { migrationJobId, accessToken } = job.data;

  logger.info(`🔄 Starting catchup sync for migration ${migrationJobId}`);

  try {
    // Get all user sync states for this migration
    const { data: userStates, error } = await supabase
      .from('user_sync_state')
      .select('*')
      .eq('migration_job_id', migrationJobId)
      .eq('status', 'completed');

    if (error) {
      throw new Error(`Failed to get user sync states: ${error.message}`);
    }

    if (!userStates || userStates.length === 0) {
      logger.warn(`No completed user sync states found for migration ${migrationJobId}`);
      return { usersCaughtUp: 0 };
    }

    // Queue delta sync jobs for each user (using their delta links)
    for (const state of userStates) {
      if (state.mail_delta_link) {
        await migrationQueue.add('mail-sync', {
          userSyncStateId: state.id,
          userId: state.provider_user_id,
          migrationJobId,
          accessToken,
          deltaLink: state.mail_delta_link, // Use saved delta link
        });
      }

      if (state.calendar_sync_token) {
        await migrationQueue.add('calendar-sync', {
          userSyncStateId: state.id,
          userId: state.provider_user_id,
          migrationJobId,
          accessToken,
          syncToken: state.calendar_sync_token,
        });
      }
    }

    // Update migration job to complete
    await supabase
      .from('migration_jobs')
      .update({
        phase: 'complete',
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', migrationJobId);

    logger.info(`✅ Catchup complete for migration ${migrationJobId}`, {
      usersCaughtUp: userStates.length,
    });

    return { usersCaughtUp: userStates.length };
  } catch (error) {
    logger.error(`❌ Catchup failed for migration ${migrationJobId}`, error);

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
