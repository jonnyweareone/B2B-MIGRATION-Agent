import { Job } from 'bull'
import { migrateBicomTenant } from '../services/bicom-mapper'
import { logger } from '../utils/logger'

interface BicomMigrationJobData {
  tenant_sync_id: string
  server_url: string
  api_key: string
  bicom_tenant_id: string
  target_org_id: string
}

export async function bicomMigrationProcessor(job: Job<BicomMigrationJobData>) {
  logger.info(`[BiCom Processor] Job ${job.id} — tenant ${job.data.bicom_tenant_id}`)
  return migrateBicomTenant(job.data)
}
