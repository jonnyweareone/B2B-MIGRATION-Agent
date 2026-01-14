# 🚂 Railway Deployment - Fixed

## ✅ Files Added to Fix Deployment

1. **nixpacks.toml** - Tells Railway how to build (Node 20 + Redis)
2. **start.sh** - Startup script (starts Redis, then Node.js)
3. **Procfile** - Backup deployment config
4. **railway.toml** - Health check settings

## 🚀 Deploy Command

```bash
cd /Users/davidsmith/Documents/GitHub/B2B-MIGRATION-Agent

# Make sure you're logged in
railway login

# Link to existing project or create new one
railway link  # if already created
# OR
railway init  # if new project

# Set environment variables
railway variables set SUPABASE_URL=https://dtosgubmmdqxbeirtbom.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0b3NndWJtbWRxeGJlaXJ0Ym9tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTE0NzgyMiwiZXhwIjoyMDgwNzIzODIyfQ.GbDGm80bDJiYso5Ihb3U8zDv4I9B0gj67y4pkI5oP4g

# Deploy
railway up

# Generate public URL
railway domain

# Should return something like:
# https://soniq-migration-worker-production.up.railway.app
```

## 📋 What Railway Will Do

1. **Install packages** - `npm ci`
2. **Build TypeScript** - `npm run build` (creates dist/)
3. **Install Redis** - Via nixpacks
4. **Start services** - Runs `./start.sh`
   - Starts Redis server on port 6379
   - Starts Node.js app (Express + Bull)
5. **Health check** - Pings `/health` endpoint
6. **Scale to zero** - Stops when idle (no cost)

## 🧪 Test After Deployment

```bash
# Get your Railway URL
RAILWAY_URL=$(railway domain)

# Test health
curl $RAILWAY_URL/health

# Should return:
# {
#   "status": "healthy",
#   "redis": "ready",
#   "queue": {...}
# }

# Test queue stats
curl $RAILWAY_URL/migrations/queue/stats

# Should return:
# {
#   "waiting": 0,
#   "active": 0,
#   "completed": 0,
#   "failed": 0,
#   "total": 0
# }
```

## 🐛 Troubleshooting

### If deployment fails:

```bash
# View logs
railway logs

# Common issues and fixes:

# 1. Redis not starting
#    - Check nixpacks.toml has redis in nixPkgs
#    - Check start.sh is executable (chmod +x start.sh)

# 2. Build fails
#    - Ensure package.json has "build": "tsc"
#    - Ensure tsconfig.json exists
#    - Run locally: npm run build

# 3. Port issues
#    - Railway sets PORT env var automatically
#    - Our code uses process.env.PORT || 3000

# 4. Environment variables missing
#    - railway variables (shows all vars)
#    - railway variables set KEY=VALUE

# 5. Health check fails
#    - Check /health endpoint works locally
#    - Ensure Express is listening on process.env.PORT
```

## 📊 Monitor After Deployment

```bash
# View live logs
railway logs --follow

# Check service status
railway status

# View metrics
railway open  # Opens Railway dashboard in browser
```

## 💰 Costs

- **Setup:** Free
- **Idle (scale-to-zero):** $0/month
- **Running (per migration):** ~$0.03 per 2 hours
- **100 migrations/month:** ~$3/month

## 🎯 Expected Output

When you run `railway up`, you should see:

```
✓ Building...
✓ Building with nixpacks
  - Installing Node.js 20.x
  - Installing Redis
  - Running npm ci
  - Running npm run build
✓ Build completed
✓ Deploying...
✓ Deployment successful
✓ Service is live at: https://your-worker.up.railway.app
```

Then test:
```bash
curl https://your-worker.up.railway.app/health
```

## ✅ Success Checklist

- [ ] Railway CLI installed (`npm i -g @railway/cli`)
- [ ] Logged in (`railway login`)
- [ ] Project created/linked
- [ ] Environment variables set
- [ ] Deployed (`railway up`)
- [ ] Domain generated (`railway domain`)
- [ ] Health check passes
- [ ] Queue stats work

## 🚀 Next Steps After Deployment

1. **Save Railway URL** to soniqmail/.env.local:
   ```bash
   MIGRATION_WORKER_URL=https://your-worker.up.railway.app
   ```

2. **Create API route** in soniqmail to call worker

3. **Build migration UI** to show progress

4. **Test full flow** with a real Microsoft 365 account

---

Need help? Check Railway logs: `railway logs --follow`
