# SONIQ B2B Migration Worker

Scale-to-zero migration worker for importing Microsoft 365 and Google Workspace organizations into SONIQ Mail.

## 🎯 Features

- **Scale to Zero** - Only runs (and costs money) during active migrations
- **Self-Contained** - Redis + Bull + Worker in single Railway service
- **Reliable** - Automatic retries, error handling, checkpointing
- **Delta Sync** - Efficient incremental syncing using Microsoft Graph delta queries
- **Progress Tracking** - Real-time progress updates via database
- **Pause/Resume** - Can pause and resume migrations mid-flight

## 🏗️ Architecture

```
Railway Service (scale-to-zero)
├── Express HTTP Server (port 3000)
├── Redis (in-memory, same process)
├── Bull Queue
└── Migration Processors
    ├── Discovery (fetch org + users)
    ├── Mail Sync (import emails with delta)
    ├── Calendar Sync (import events)
    └── Catchup (final delta sync after DNS cutover)
```

## 📋 Prerequisites

- Node.js 20+
- Railway account
- Supabase project with migration tables

## 🚀 Deployment

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### 3. Deploy to Railway

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Set environment variables
railway variables set SUPABASE_URL=https://xxx.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJxxx

# Deploy
railway up
```

### 4. Get Railway URL

```bash
railway domain
# Returns: https://your-worker.up.railway.app
```

## 📡 API Endpoints

### Start Migration

```bash
POST /migrations/start
Content-Type: application/json

{
  "orgId": "uuid",
  "accessToken": "Microsoft Graph access token",
  "provider": "microsoft365"
}

# Response
{
  "migrationJobId": "uuid",
  "bullJobId": "123",
  "status": "started"
}
```

### Get Status

```bash
GET /migrations/:id/status

# Response
{
  "id": "uuid",
  "org_id": "uuid",
  "phase": "staging",
  "status": "running",
  "users_count": 50,
  "mailboxes_count": 50,
  "users_synced": 12,
  "items_imported": 45000,
  "bytes_imported": 2400000000,
  "queueStats": {
    "waiting": 38,
    "active": 5,
    "completed": 12,
    "failed": 0
  }
}
```

### Pause Migration

```bash
POST /migrations/:id/pause

# Response
{
  "status": "paused"
}
```

### Resume Migration

```bash
POST /migrations/:id/resume
Content-Type: application/json

{
  "accessToken": "Microsoft Graph access token"
}

# Response
{
  "status": "resumed",
  "queuedUsers": 38
}
```

### Queue Statistics

```bash
GET /migrations/queue/stats

# Response
{
  "waiting": 100,
  "active": 10,
  "completed": 500,
  "failed": 2,
  "total": 612
}
```

### Health Check

```bash
GET /health

# Response
{
  "status": "healthy",
  "redis": "ready",
  "queue": {
    "waiting": 0,
    "active": 5,
    "completed": 100,
    "failed": 0
  },
  "uptime": 3600,
  "memory": {...}
}
```

## 🔄 Migration Phases

### 1. Discovery (Phase 1)
- Fetches organization info
- Lists all users
- Counts mailbox sizes
- Estimates migration time
- Creates user sync state records
- Queues mail sync jobs

### 2. Staging (Phase 2)
- Processes mail sync jobs in parallel (5 concurrent)
- Uses Microsoft Graph delta queries
- Saves delta links for incremental sync
- Updates progress in real-time

### 3. DNS Cutover (Phase 3)
- User updates MX records
- New mail flows to SONIQ
- Worker continues in background

### 4. Catchup (Phase 4)
- Runs delta sync for all users
- Pulls changes since staging started
- Marks migration as complete

## 💰 Cost (Scale-to-Zero)

**When IDLE:**
- $0/month (scaled to zero)

**When Running:**
- ~$0.000231/min (512MB RAM)
- Example: 2-hour migration = ~$0.028
- 100 migrations/month = **~$2.80/month**

## 🛠️ Development

```bash
# Run locally
npm run dev

# Build
npm run build

# Start production
npm start
```

## 📊 Database Schema Required

The worker requires these tables in Supabase:

```sql
-- migration_jobs table
CREATE TABLE migration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  phase text NOT NULL,
  status text NOT NULL,
  users_count int,
  mailboxes_count int,
  total_size_bytes bigint,
  estimated_duration_minutes int,
  users_synced int DEFAULT 0,
  mailboxes_synced int DEFAULT 0,
  items_imported bigint DEFAULT 0,
  bytes_imported bigint DEFAULT 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- user_sync_state table
CREATE TABLE user_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_job_id uuid REFERENCES migration_jobs(id),
  user_email text NOT NULL,
  provider_user_id text NOT NULL,
  status text DEFAULT 'pending',
  mail_items_synced int DEFAULT 0,
  mail_bytes_synced bigint DEFAULT 0,
  mail_delta_link text,
  mail_last_synced_at timestamptz,
  calendar_events_synced int DEFAULT 0,
  calendar_sync_token text,
  calendar_last_synced_at timestamptz,
  files_synced int DEFAULT 0,
  files_bytes_synced bigint DEFAULT 0,
  files_delta_link text,
  files_last_synced_at timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now()
);
```

## 🔐 Security

- Service role key stored in Railway env vars
- Access tokens passed per-request (not stored)
- Bull jobs cleaned up after 24 hours
- Error messages sanitized

## 📝 License

Proprietary - Guardian Network Solutions

## 🤝 Support

For issues or questions, contact: support@guardiannetwork.solutions
