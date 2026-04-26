import { Router } from 'express';
import { migrationQueue, supabase } from '../index';
import { logger } from '../utils/logger';

const router = Router();

// Middleware to verify API key
const verifyApiKey = (req: any, res: any, next: any) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid API key' });
  }
  
  next();
};

// Apply to all routes
router.use(verifyApiKey);

// Start migration
router.post('/start', async (req, res) => {
  try {
    const {
      orgId,
      accessToken,
      provider,
      syncMode = 'directory_only',
      msTenantId,
      tenantSyncJobId,
    } = req.body;

    if (!orgId || !accessToken || !provider) {
      return res.status(400).json({
        error: 'Missing required fields: orgId, accessToken, provider',
      });
    }

    if (syncMode && !['directory_only', 'full'].includes(syncMode)) {
      return res.status(400).json({
        error: "syncMode must be 'directory_only' or 'full'",
      });
    }

    // Create migration job in database
    const { data: migrationJob, error: dbError } = await supabase
      .from('migration_jobs')
      .insert({
        org_id: orgId,
        provider,
        phase: 'discovery',
        status: 'pending',
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      logger.error('Failed to create migration job:', dbError);
      return res.status(500).json({ error: dbError.message });
    }

    // Add discovery job to Bull queue
    const job = await migrationQueue.add('discovery', {
      migrationJobId: migrationJob.id,
      orgId,
      accessToken,
      provider,
      syncMode,
      msTenantId,
      tenantSyncJobId,
    });

    logger.info(`🚀 Started migration job ${migrationJob.id}`, {
      migrationJobId: migrationJob.id,
      bullJobId: job.id,
      orgId,
      provider,
      syncMode,
    });

    res.json({
      migrationJobId: migrationJob.id,
      bullJobId: job.id,
      status: 'started',
      syncMode,
    });
  } catch (error) {
    logger.error('Error starting migration:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get migration status (read-only, no auth needed)
router.get('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    // Get job from database
    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select(`
        *,
        user_sync_state (
          user_email,
          mail_items_synced,
          mail_bytes_synced,
          calendar_events_synced,
          files_synced,
          status
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Migration job not found' });
    }

    // Get Bull queue stats for this migration
    const [waitingJobs, activeJobs, completedJobs, failedJobs] = await Promise.all([
      migrationQueue.getJobs(['waiting']),
      migrationQueue.getJobs(['active']),
      migrationQueue.getJobs(['completed']),
      migrationQueue.getJobs(['failed']),
    ]);

    const queueStats = {
      waiting: waitingJobs.filter((j) => j.data.migrationJobId === id).length,
      active: activeJobs.filter((j) => j.data.migrationJobId === id).length,
      completed: completedJobs.filter((j) => j.data.migrationJobId === id).length,
      failed: failedJobs.filter((j) => j.data.migrationJobId === id).length,
    };

    res.json({
      ...job,
      queueStats,
    });
  } catch (error) {
    logger.error('Error getting migration status:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Pause migration
router.post('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;

    // Update database
    await supabase
      .from('migration_jobs')
      .update({ status: 'paused' })
      .eq('id', id);

    // Remove pending Bull jobs
    const jobs = await migrationQueue.getJobs(['waiting', 'active']);
    const relatedJobs = jobs.filter((j) => j.data.migrationJobId === id);
    
    for (const job of relatedJobs) {
      await job.remove();
    }

    logger.info(`⏸️  Paused migration ${id}`);
    res.json({ status: 'paused' });
  } catch (error) {
    logger.error('Error pausing migration:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Resume migration
router.post('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Missing accessToken' });
    }

    // Update database
    await supabase
      .from('migration_jobs')
      .update({ status: 'running' })
      .eq('id', id);

    // Get pending user sync states
    const { data: pendingUsers } = await supabase
      .from('user_sync_state')
      .select('*')
      .eq('migration_job_id', id)
      .eq('status', 'pending');

    // Re-add jobs to queue
    if (pendingUsers) {
      for (const user of pendingUsers) {
        await migrationQueue.add('mail-sync', {
          userSyncStateId: user.id,
          userId: user.provider_user_id,
          migrationJobId: id,
          accessToken,
        });
      }
    }

    logger.info(`▶️  Resumed migration ${id}`);
    res.json({ status: 'resumed', queuedUsers: pendingUsers?.length || 0 });
  } catch (error) {
    logger.error('Error resuming migration:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get queue statistics (read-only, no auth needed)
router.get('/queue/stats', async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      migrationQueue.getWaitingCount(),
      migrationQueue.getActiveCount(),
      migrationQueue.getCompletedCount(),
      migrationQueue.getFailedCount(),
    ]);

    res.json({
      waiting,
      active,
      completed,
      failed,
      total: waiting + active + completed + failed,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
