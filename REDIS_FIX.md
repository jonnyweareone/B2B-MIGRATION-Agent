# 🔧 REDIS FIX - Dockerfile Deployment

## 🐛 Problem
```
./start.sh: line 5: redis-server: command not found
Redis failed to start
```

**Root cause:** Nixpacks wasn't installing Redis properly in the Railway container.

---

## ✅ Solution - Switch to Dockerfile

### What Changed:

1. **Created Dockerfile** ⭐
   - Uses `node:20-alpine` (lightweight)
   - Installs Redis via `apk add redis`
   - Builds TypeScript
   - Runs `start.sh`

2. **Updated railway.toml**
   - Changed builder from `nixpacks` to `dockerfile`

3. **Improved start.sh**
   - Better error handling
   - 30-second timeout for Redis
   - More verbose logging

4. **Added .dockerignore**
   - Excludes unnecessary files from build

---

## 🚀 Deploy the Fix

```bash
cd /Users/davidsmith/Documents/GitHub/B2B-MIGRATION-Agent

# Push to trigger Railway rebuild
git push origin main

# Railway will automatically:
# 1. Detect Dockerfile
# 2. Build image with Redis
# 3. Deploy new container
# 4. Health check /health endpoint
```

---

## 📋 What Railway Will Do Now

**Old (Broken - Nixpacks):**
```
❌ Nixpacks build
❌ Redis not properly installed
❌ start.sh fails: redis-server not found
```

**New (Fixed - Dockerfile):**
```
✅ Build Dockerfile
✅ Install Redis via apk
✅ Copy source code
✅ Build TypeScript (npm run build)
✅ Run start.sh
   ├─ Start Redis server
   ├─ Wait for Redis ready (30s timeout)
   └─ Start Node.js app
✅ Health check passes
```

---

## 🧪 Test After Deployment

Wait 2-3 minutes for Railway to rebuild, then:

```bash
# Check health
curl https://b2b-migration-agent-production.up.railway.app/health

# Expected response:
{
  "status": "healthy",
  "redis": "ready",
  "queue": {
    "waiting": 0,
    "active": 0,
    "completed": 0,
    "failed": 0
  },
  "uptime": 5,
  "memory": {...}
}

# Check queue stats
curl https://b2b-migration-agent-production.up.railway.app/migrations/queue/stats

# Expected response:
{
  "waiting": 0,
  "active": 0,
  "completed": 0,
  "failed": 0,
  "total": 0
}
```

---

## 🔍 Debug in Railway

### View Logs
```bash
railway logs --follow
```

**What to look for:**
```
✅ "🚀 Starting SONIQ Migration Worker..."
✅ "📦 Starting Redis..."
✅ "✅ Redis is ready!"
✅ "🚀 Starting Node.js application..."
✅ "🚀 Migration worker listening on port 3000"
```

**If you see errors:**
- Check Redis installation: `apk add redis`
- Check start.sh permissions: `chmod +x start.sh`
- Check PORT env var: Railway sets this automatically

---

## 📁 Files Changed

| File | Change | Purpose |
|------|--------|---------|
| Dockerfile | ✅ Created | Build container with Node + Redis |
| .dockerignore | ✅ Created | Exclude unnecessary files |
| railway.toml | ✅ Updated | Use Dockerfile builder |
| nixpacks.toml | ⚠️ Kept | Fallback (not used) |
| start.sh | ✅ Updated | Better error handling |

---

## 🎯 Alternative: If Dockerfile Fails

If for some reason Dockerfile also fails, here's a fallback:

### Option 1: Use Railway Redis Plugin

```bash
# Add Redis plugin in Railway dashboard
railway add redis

# Update code to use REDIS_URL from plugin
# Remove Redis from start.sh
```

### Option 2: External Redis (Upstash)

```bash
# Sign up for Upstash Redis (free tier)
# Get Redis URL
railway variables set REDIS_URL=redis://...

# Update src/index.ts to use REDIS_URL
```

But Dockerfile should work! The Alpine package manager `apk` is very reliable.

---

## ✅ Expected Timeline

- **Push to GitHub:** Immediate
- **Railway detects changes:** ~10 seconds
- **Build Dockerfile:** 2-3 minutes
- **Deploy container:** 30 seconds
- **Health check:** 10 seconds
- **Total:** ~3-4 minutes

---

## 🎉 After This Fix

Once deployed successfully:

1. ✅ Redis will be running in-memory
2. ✅ Bull queue will work
3. ✅ Health endpoint will return 200
4. ✅ Migration endpoints will be ready
5. ✅ Scale-to-zero will work

Then you can:
- Test full migration flow
- Build migration UI
- Connect Microsoft 365

---

## 💰 Costs (Unchanged)

- **Idle:** $0/month (scale-to-zero)
- **Running:** ~$0.03 per 2-hour migration
- **Dockerfile:** Same cost as Nixpacks

---

## 🚨 If Still Failing

Check Railway logs for:
```bash
railway logs --tail 100

# Look for:
# - "redis-server: command not found" (still broken)
# - "Permission denied: start.sh" (chmod issue)
# - "Cannot find module" (build issue)
```

If Redis still not found, Railway support can help or we'll switch to Redis plugin approach.

---

**Status:** Committed and ready to push! 🚀

Run: `git push origin main`
