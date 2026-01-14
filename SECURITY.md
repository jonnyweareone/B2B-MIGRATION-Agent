# 🔐 Security Setup

## ✅ Added API Key Authentication

The worker now requires an API key for all write operations (start, pause, resume).

### Updated Files:
- ✅ `src/routes/migrations.ts` - Added API key middleware
- ✅ `.env` - Added `API_KEY=soniq-migration-secret-2024-guardian`
- ✅ `.env.example` - Template updated

## 🔒 Protected Endpoints

**Require API Key:**
- `POST /migrations/start`
- `POST /migrations/:id/pause`
- `POST /migrations/:id/resume`

**No Auth (Read-only):**
- `GET /migrations/:id/status`
- `GET /migrations/queue/stats`
- `GET /health`

## 📡 How to Call from Next.js

### 1. Add to soniqmail/.env.local

```bash
# Railway Worker
MIGRATION_WORKER_URL=https://your-worker.up.railway.app
MIGRATION_WORKER_API_KEY=soniq-migration-secret-2024-guardian
```

### 2. Create API Route in Next.js

```typescript
// app/api/migrations/start/route.ts
export async function POST(req: Request) {
  const { orgId, accessToken } = await req.json();
  
  const response = await fetch(
    `${process.env.MIGRATION_WORKER_URL}/migrations/start`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.MIGRATION_WORKER_API_KEY!,
      },
      body: JSON.stringify({
        orgId,
        accessToken,
        provider: 'microsoft365',
      }),
    }
  );
  
  if (!response.ok) {
    throw new Error('Failed to start migration');
  }
  
  return Response.json(await response.json());
}
```

### 3. Call from Frontend

```typescript
// Client-side code
const startMigration = async (orgId: string, accessToken: string) => {
  const response = await fetch('/api/migrations/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId, accessToken }),
  });
  
  const data = await response.json();
  return data.migrationJobId;
};
```

## 🚂 Railway Deployment

When deploying, set the API_KEY environment variable:

```bash
railway variables set API_KEY=soniq-migration-secret-2024-guardian
```

**Or generate a secure random key:**

```bash
# Generate secure 32-byte key
API_KEY=$(openssl rand -hex 32)
railway variables set API_KEY=$API_KEY

# Save this key to soniqmail/.env.local
echo "MIGRATION_WORKER_API_KEY=$API_KEY" >> ../soniqmail/.env.local
```

## ⚠️ Security Best Practices

1. **Never expose API key in client code** - Always proxy through Next.js API routes
2. **Use HTTPS only** - Railway provides this automatically
3. **Rotate keys regularly** - Update both Railway and Next.js .env
4. **Monitor logs** - Check for unauthorized access attempts
5. **Rate limit** - Consider adding rate limiting middleware (optional)

## 🧪 Testing with API Key

### Local Testing

```bash
# With API key
curl -X POST http://localhost:3000/migrations/start \
  -H "Content-Type: application/json" \
  -H "X-API-Key: soniq-migration-secret-2024-guardian" \
  -d '{
    "orgId": "uuid",
    "accessToken": "token",
    "provider": "microsoft365"
  }'

# Without API key (should fail with 401)
curl -X POST http://localhost:3000/migrations/start \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "uuid",
    "accessToken": "token",
    "provider": "microsoft365"
  }'
```

### Production Testing

```bash
curl -X POST https://your-worker.up.railway.app/migrations/start \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-production-api-key" \
  -d '{...}'
```

## 📋 Checklist

- [x] API key middleware added to routes
- [x] .env updated with API_KEY
- [x] .env.example updated
- [ ] Deploy to Railway with API_KEY
- [ ] Add MIGRATION_WORKER_API_KEY to soniqmail/.env.local
- [ ] Create Next.js API proxy route
- [ ] Test authentication works

## 🎯 Error Responses

**401 Unauthorized:**
```json
{
  "error": "Unauthorized - Invalid API key"
}
```

**Missing API Key:**
```json
{
  "error": "Unauthorized - Invalid API key"
}
```

## ✅ Status: Secured!

All write operations now require API key authentication. Read-only endpoints remain public for progress tracking.
