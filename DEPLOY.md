# Quick Deploy to Railway

## 1. Create .env file

```bash
cp .env.example .env
```

Then edit `.env` with your Supabase credentials:
```
SUPABASE_URL=https://dtosgubmmdqxbeirtbom.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

## 2. Test Locally (Optional)

```bash
# Start Redis locally first
redis-server

# In another terminal
npm run dev
```

Test the health endpoint:
```bash
curl http://localhost:3000/health
```

## 3. Deploy to Railway

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize new project
railway init
# Choose: "Create new project"
# Name it: "soniq-migration-worker"

# Set environment variables
railway variables set SUPABASE_URL=https://dtosgubmmdqxbeirtbom.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=your_key_here

# Deploy
railway up
```

## 4. Get Your Worker URL

```bash
railway domain
```

This returns something like:
```
https://soniq-migration-worker-production.up.railway.app
```

## 5. Test Deployment

```bash
# Health check
curl https://soniq-migration-worker-production.up.railway.app/health

# Queue stats
curl https://soniq-migration-worker-production.up.railway.app/migrations/queue/stats
```

## 6. Update SONIQ Mail to Use Worker

In your Next.js app, update the migration API route:

```typescript
// app/api/migrations/start/route.ts
const WORKER_URL = process.env.MIGRATION_WORKER_URL || 'https://soniq-migration-worker-production.up.railway.app';

export async function POST(req: Request) {
  const { orgId, accessToken } = await req.json();

  const response = await fetch(`${WORKER_URL}/migrations/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgId,
      accessToken,
      provider: 'microsoft365',
    }),
  });

  const data = await response.json();
  return Response.json(data);
}
```

## Railway Configuration

The `railway.toml` file configures:
- ✅ Scale to zero when idle (no cost)
- ✅ Auto-wake on HTTP requests
- ✅ Health check endpoint
- ✅ Automatic restarts on failure

## Monitoring

View logs in Railway dashboard:
```bash
railway logs
```

Or open the dashboard:
```bash
railway open
```

## Cost

**Idle**: $0/month (scaled to zero)  
**Active**: ~$0.000231/minute  
**100 migrations/month** @ 2 hours each = **~$2.80/month**

---

🎉 You're ready to migrate organizations!
