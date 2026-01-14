import { Job } from 'bull';
import { Client } from '@microsoft/microsoft-graph-client';
import { supabase } from '../index';
import { logger } from '../utils/logger';

interface MailSyncJobData {
  userSyncStateId: string;
  userId: string;
  migrationJobId: string;
  accessToken: string;
  deltaLink?: string; // For incremental sync
}

export async function mailSyncProcessor(job: Job<MailSyncJobData>) {
  const { userSyncStateId, userId, migrationJobId, accessToken, deltaLink } = job.data;

  logger.info(`📧 Starting mail sync for user sync state ${userSyncStateId}`);

  try {
    const client = Client.init({
      authProvider: (done) => done(null, accessToken),
    });

    // Update status to running
    await supabase
      .from('user_sync_state')
      .update({ status: 'running' })
      .eq('id', userSyncStateId);

    // Use delta query if available, otherwise full sync
    const endpoint = deltaLink || `/users/${userId}/messages/delta`;
    
    let itemsSynced = 0;
    let bytesSynced = 0;
    let nextLink = endpoint;
    let newDeltaLink = '';

    while (nextLink) {
      // Fetch page of messages
      const response = await client.api(nextLink).get();
      const messages = response.value || [];

      // Process messages
      for (const message of messages) {
        // TODO: Store message in your mail system via Supabase Edge Function
        // For now, just count
        itemsSynced++;
        bytesSynced += message.body?.content?.length || 0;

        // Update progress every 10 messages
        if (itemsSynced % 10 === 0) {
          await supabase
            .from('user_sync_state')
            .update({
              mail_items_synced: itemsSynced,
              mail_bytes_synced: bytesSynced,
              mail_last_synced_at: new Date().toISOString(),
            })
            .eq('id', userSyncStateId);

          job.progress(Math.min(99, (itemsSynced / 100) * 100));
        }
      }

      // Get next page or delta link
      nextLink = response['@odata.nextLink'];
      
      // Save delta link for incremental sync
      if (response['@odata.deltaLink']) {
        newDeltaLink = response['@odata.deltaLink'];
        break;
      }
    }

    // Final update
    await supabase
      .from('user_sync_state')
      .update({
        mail_items_synced: itemsSynced,
        mail_bytes_synced: bytesSynced,
        mail_delta_link: newDeltaLink || deltaLink,
        mail_last_synced_at: new Date().toISOString(),
        status: 'completed',
      })
      .eq('id', userSyncStateId);

    job.progress(100);

    logger.info(`✅ Mail sync complete for user sync state ${userSyncStateId}`, {
      itemsSynced,
      bytesSynced: (bytesSynced / 1024 / 1024).toFixed(2) + ' MB',
    });

    return { itemsSynced, bytesSynced };
  } catch (error) {
    logger.error(`❌ Mail sync failed for user sync state ${userSyncStateId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    await supabase
      .from('user_sync_state')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', userSyncStateId);

    throw error;
  }
}
