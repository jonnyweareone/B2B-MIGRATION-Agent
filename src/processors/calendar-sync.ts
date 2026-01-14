import { Job } from 'bull';
import { Client } from '@microsoft/microsoft-graph-client';
import { supabase } from '../index';
import { logger } from '../utils/logger';

interface CalendarSyncJobData {
  userSyncStateId: string;
  userId: string;
  migrationJobId: string;
  accessToken: string;
  syncToken?: string;
}

export async function calendarSyncProcessor(job: Job<CalendarSyncJobData>) {
  const { userSyncStateId, userId, accessToken, syncToken } = job.data;

  logger.info(`📅 Starting calendar sync for user sync state ${userSyncStateId}`);

  try {
    const client = Client.init({
      authProvider: (done) => done(null, accessToken),
    });

    const endpoint = syncToken
      ? syncToken
      : `/users/${userId}/calendar/events/delta`;
    
    let eventsSynced = 0;
    let nextLink = endpoint;
    let newSyncToken = '';

    while (nextLink) {
      const response = await client.api(nextLink).get();
      const events = response.value || [];

      for (const event of events) {
        // TODO: Store event in your calendar system
        eventsSynced++;
      }

      nextLink = response['@odata.nextLink'];
      
      if (response['@odata.deltaLink']) {
        newSyncToken = response['@odata.deltaLink'];
        break;
      }

      job.progress(Math.min(99, (eventsSynced / 50) * 100));
    }

    await supabase
      .from('user_sync_state')
      .update({
        calendar_events_synced: eventsSynced,
        calendar_sync_token: newSyncToken || syncToken,
        calendar_last_synced_at: new Date().toISOString(),
      })
      .eq('id', userSyncStateId);

    job.progress(100);

    logger.info(`✅ Calendar sync complete`, { eventsSynced });
    return { eventsSynced };
  } catch (error) {
    logger.error(`❌ Calendar sync failed`, error);
    throw error;
  }
}
