// SONIQ B2B Migration Worker — S3 storage utility for connected mail bodies
// Mirrors soniqmail/src/lib/s3.ts pattern. PeaSoup S3-compatible (Ceph RGW).
// Body of every synced M365/Google email is written here under Object Lock.

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ObjectLockMode,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { logger } from './logger';

// PeaSoup S3 client — same Ceph RGW compatibility flags as soniqmail
export const s3Client = new S3Client({
  region: process.env.S3_REGION || 'eu-west-1',
  endpoint: process.env.S3_ENDPOINT || 'https://s3.eu-west-1.peasoup.cloud',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Bucket for connected-mail backup. WORM-enabled at bucket level.
// Created out-of-band on PeaSoup; this worker just writes to it.
export const MAIL_ARCHIVE_BUCKET =
  process.env.S3_BUCKET_MAIL_ARCHIVE || 'soniq-mail-archive';

export type LockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface UploadMailBodyParams {
  orgId: string;
  msUserId: string;
  messageId: string;
  body: Buffer;
  contentType?: string;
  retentionDays: number;
  lockMode: LockMode;
  metadata?: {
    subject?: string;
    fromAddress?: string;
    receivedAt?: string;
    sizeBytes?: number;
  };
}

export interface UploadMailBodyResult {
  bucket: string;
  key: string;
  size: number;
  hash: string;
  retainUntil: Date;
  lockMode: LockMode;
}

/**
 * Upload a mail body (raw MIME or content blob) to the archive bucket
 * with Object Lock retention. The retain-until date is computed from
 * retentionDays and applied at upload — Ceph RGW honours these S3 headers.
 *
 * Key shape: <orgId>/<msUserId>/<yyyy>/<mm>/<dd>/<messageId>.eml
 * — partitioned by date for efficient lifecycle/expiry sweeps later.
 */
export async function uploadMailBody(
  params: UploadMailBodyParams,
): Promise<UploadMailBodyResult> {
  const {
    orgId,
    msUserId,
    messageId,
    body,
    contentType = 'message/rfc822',
    retentionDays,
    lockMode,
    metadata = {},
  } = params;

  const hash = createHash('sha256').update(body).digest('hex');
  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const safeMessageId = messageId.replace(/[^A-Za-z0-9._-]/g, '_');
  const key = `${orgId}/${msUserId}/${datePath}/${safeMessageId}.eml`;

  const retainUntil = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: MAIL_ARCHIVE_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ObjectLockMode: lockMode as ObjectLockMode,
      ObjectLockRetainUntilDate: retainUntil,
      Metadata: {
        'x-soniq-org-id': orgId,
        'x-soniq-ms-user-id': msUserId,
        'x-soniq-message-id': messageId,
        'x-soniq-hash': hash,
        'x-soniq-subject': (metadata.subject || '').slice(0, 256),
        'x-soniq-from': (metadata.fromAddress || '').slice(0, 256),
        'x-soniq-received-at': metadata.receivedAt || '',
        'x-soniq-archived-at': now.toISOString(),
      },
    }),
  );

  return {
    bucket: MAIL_ARCHIVE_BUCKET,
    key,
    size: body.length,
    hash,
    retainUntil,
    lockMode,
  };
}

/**
 * Idempotency check — has this message already been archived?
 * Avoid re-uploading on retry/delta cycles.
 */
export async function mailBodyExists(
  orgId: string,
  msUserId: string,
  messageId: string,
): Promise<boolean> {
  // Best-effort: we don't know the dated path without listing, so we rely on
  // upstream tracking in user_sync_state.mail_last_synced_at and the message_id
  // dedupe in the synced_emails row. This helper is a placeholder for explicit
  // HEAD checks if needed by retry logic.
  try {
    const today = new Date();
    const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const safeMessageId = messageId.replace(/[^A-Za-z0-9._-]/g, '_');
    const key = `${orgId}/${msUserId}/${datePath}/${safeMessageId}.eml`;

    await s3Client.send(
      new HeadObjectCommand({ Bucket: MAIL_ARCHIVE_BUCKET, Key: key }),
    );
    return true;
  } catch {
    return false;
  }
}

logger.info(`📦 S3 archive ready: ${MAIL_ARCHIVE_BUCKET} @ ${process.env.S3_ENDPOINT || 'https://s3.eu-west-1.peasoup.cloud'}`);
