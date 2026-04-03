import { Job } from 'bull';
import { supabase } from '../index';
import { logger } from '../utils/logger';

interface WebhookRenewJobData {
  // No specific data needed - it processes all accounts
}

export async function webhookRenewProcessor(job: Job<WebhookRenewJobData>) {
  logger.info('🔄 Starting webhook renewal process');

  try {
    // Call the Supabase edge function that handles webhook renewal
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/webhook-renew`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook renewal failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();

    logger.info('✅ Webhook renewal completed', {
      renewed: result.renewed,
      failed: result.failed,
      results: result.results,
    });

    // Report detailed results
    if (result.results && result.results.length > 0) {
      result.results.forEach((r: any) => {
        if (r.status === 'success') {
          logger.info(`✓ Renewed webhook for ${r.email}`, {
            webhookId: r.webhook_id,
            expiresAt: r.expires_at,
          });
        } else {
          logger.error(`✗ Failed to renew webhook for ${r.email}`, {
            error: r.error,
          });
        }
      });
    }

    return {
      renewed: result.renewed,
      failed: result.failed,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('❌ Webhook renewal process failed', error);
    throw error;
  }
}
