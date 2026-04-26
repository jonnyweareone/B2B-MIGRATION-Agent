import { Job } from 'bull';
import { Client } from '@microsoft/microsoft-graph-client';
import { supabase } from '../index';
import { logger } from '../utils/logger';
import { uploadMailBody } from '../utils/s3-archive';
import { getEffectiveRetention } from '../utils/tenant-config';

interface MailSyncJobData {
  userSyncStateId: string;
  userId: string;
  migrationJobId: string;
  orgId: string;                   // SONIQ customer_org_id (needed for retention lookup)
  accessToken: string;
  deltaLink?: string;
}

/**
 * Per-user mail back-sync. Uses Graph delta query for efficient incremental
 * pulls. Each message:
 *   1. Body bytes -> PeaSoup S3 with Object Lock + retention from licence
 *   2. Metadata + S3 key -> mail.synced_emails row in Supabase
 *
 * Retention is resolved once per job (cached). Idempotent: re-running with
 * the same delta link is a no-op for already-synced messages.
 */
export async function mailSyncProcessor(job: Job<MailSyncJobData>) {
  const {
    userSyncStateId,
    userId,
    migrationJobId,
    orgId,
    accessToken,
    deltaLink,
  } = job.data;

  logger.info(`📧 Mail sync start: user=${userId} state=${userSyncStateId}`);

  try {
    const client = Client.init({ authProvider: (done) => done(null, accessToken) });

    // Resolve retention once per user per run
    const { retentionDays, lockMode } = await getEffectiveRetention(orgId);
    logger.info(`  retention: ${retentionDays}d ${lockMode}`);

    await supabase
      .from('user_sync_state')
      .update({ status: 'running' })
      .eq('id', userSyncStateId);

    let endpoint: string =
      deltaLink || `/users/${userId}/messages/delta?$top=50`;
    let itemsSynced = 0;
    let bytesSynced = 0;
    let newDeltaLink = '';

    while (endpoint) {
      const response: any = await client.api(endpoint).get();
      const messages = response.value || [];

      for (const message of messages) {
        // Build the body bytes (HTML or text). For full MIME we'd hit /$value
        // but that's a separate Graph call per message — defer to optimisation.
        const bodyContent = message.body?.content || '';
        const buf = Buffer.from(bodyContent, 'utf8');

        try {
          // 1) Object Lock'd S3 archive
          const archived = await uploadMailBody({
            orgId,
            msUserId: userId,
            messageId: message.id,
            body: buf,
            contentType: message.body?.contentType === 'html'
              ? 'text/html; charset=utf-8'
              : 'text/plain; charset=utf-8',
            retentionDays,
            lockMode,
            metadata: {
              subject: message.subject,
              fromAddress: message.from?.emailAddress?.address,
              receivedAt: message.receivedDateTime,
              sizeBytes: buf.length,
            },
          });

          // 2) Postgres metadata row (idempotent on org_id+message_id)
          await supabase
            .from('mail.synced_emails' as any)
            .upsert(
              {
                org_id: orgId,
                ms_user_id: userId,
                message_id: message.id,
                conversation_id: message.conversationId,
                subject: message.subject,
                from_address: message.from?.emailAddress?.address,
                from_name: message.from?.emailAddress?.name,
                to_recipients: message.toRecipients?.map((r: any) => r.emailAddress?.address) || [],
                cc_recipients: message.ccRecipients?.map((r: any) => r.emailAddress?.address) || [],
                received_at: message.receivedDateTime,
                sent_at: message.sentDateTime,
                has_attachments: message.hasAttachments || false,
                importance: message.importance,
                is_read: message.isRead,
                snippet: (message.bodyPreview || '').slice(0, 500),
                s3_body_key: archived.key,
                s3_body_bucket: archived.bucket,
                s3_body_size_bytes: archived.size,
                object_lock_retain_until: archived.retainUntil.toISOString(),
                object_lock_mode: archived.lockMode,
                synced_at: new Date().toISOString(),
              },
              { onConflict: 'org_id,message_id', ignoreDuplicates: false },
            );

          itemsSynced++;
          bytesSynced += archived.size;
        } catch (msgErr) {
          // Don't fail the whole job for one bad message; log and continue
          logger.warn(`  message sync failed`, {
            messageId: message.id,
            error: msgErr instanceof Error ? msgErr.message : String(msgErr),
          });
        }

        if (itemsSynced % 25 === 0) {
          await supabase
            .from('user_sync_state')
            .update({
              mail_items_synced: itemsSynced,
              mail_bytes_synced: bytesSynced,
              mail_last_synced_at: new Date().toISOString(),
            })
            .eq('id', userSyncStateId);

          job.progress(Math.min(99, Math.round((itemsSynced / 1000) * 100)));
        }
      }

      if (response['@odata.deltaLink']) {
        newDeltaLink = response['@odata.deltaLink'];
        break;
      }
      endpoint = response['@odata.nextLink'] || '';
    }

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
    logger.info(`✅ Mail sync complete: user=${userId} items=${itemsSynced} bytes=${(bytesSynced / 1024 / 1024).toFixed(2)}MB`);
    return { itemsSynced, bytesSynced };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Mail sync failed for ${userSyncStateId}`, { error: msg });
    await supabase
      .from('user_sync_state')
      .update({ status: 'failed', error_message: msg })
      .eq('id', userSyncStateId);
    throw error;
  }
}
