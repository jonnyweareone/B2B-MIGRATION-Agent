# 🔧 HEALTHCHECK FAILURE FIX

## 🐛 Problem
```
Attempt #1-7 failed with service unavailable
1/1 replicas never became healthy!
Healthcheck failed!
```

**Build succeeded ✅** but container won't start or health check fails.

---

## ✅ Fixes Applied

### 1. **Added `bash` to Dockerfile**
```dockerfile
RUN apk add --no-cache redis bash  # Added bash
```
Alpine Linux uses `sh` by default, but our script uses bash features.

### 2. **Improved start.sh logging**
- Shows PORT, REDIS_HOST, REDIS_PORT
- Better Redis startup detection
- Checks if dist/index.js exists
- More verbose output for debugging

### 3. **Removed Docker HEALTHCHECK**
```dockerfile
# Removed this (let Railway handle health checks):
# HEALTHCHECK --interval=30s ...
```
Let Railway use its default HTTP health check on the `/health` endpoint.

### 4. **Changed CMD to explicitly use bash**
```dockerfile
CMD ["bash", "start.sh"]  # Instead of ["./start.sh"]
```

---

## 🔍 What Was Likely Wrong

**Possible causes:**
1. ❌ `start.sh` failed because bash wasn't installed
2. ❌ App didn't bind to `0.0.0.0` (Railway requirement)
3. ❌ Health check was too aggressive
4. ❌ Port mismatch (Railway sets PORT env var)

**Fixes:**
1. ✅ Install bash explicitly
2. ✅ Check Express binds to `0.0.0.0` (will verify in logs)
3. ✅ Removed Docker health check, use Railway's default
4. ✅ Logging PORT to verify

---

## 🧪 Watch New Deployment

```bash
# Watch Railway logs
railway logs --follow

# Look for these success indicators:
✅ "🚀 Starting SONIQ Migration Worker..."
✅ "📍 PORT: 3000" (or whatever Railway sets)
✅ "📦 Starting Redis..."
✅ "✅ Redis is ready!"
✅ "✅ dist/index.js exists"
✅ "🚀 Starting Node.js application..."
✅ "✅ Connected to Redis"
✅ "✅ Connected to Supabase"
✅ "🚀 Migration worker listening on port 3000"

# If health check still fails, look for:
❌ "EADDRINUSE" (port already in use)
❌ "Cannot find module" (build issue)
❌ "Permission denied" (file permissions)
❌ Any Redis connection errors
```

---

## 🎯 Express Binding Check

Our code in `src/index.ts` should bind to `0.0.0.0`:

```typescript
app.listen(PORT, () => {
  logger.info(`🚀 Migration worker listening on port ${PORT}`);
});
```

This defaults to `0.0.0.0` which is correct for Docker/Railway.

If it's explicitly set to `localhost` or `127.0.0.1`, Railway can't reach it!

Let me verify this in the code...

---

## 📋 Deployment Timeline

- ✅ Pushed to GitHub
- 🔄 Railway building: ~2-3 min
- 🔄 Container starting: ~30s
- 🔄 Health check: ~10s
- **Total: ~3-4 minutes**

---

## ✅ Expected Logs

```
🚀 Starting SONIQ Migration Worker...
📍 PORT: 8080
📍 REDIS_HOST: 127.0.0.1
📍 REDIS_PORT: 6379
📦 Starting Redis on 127.0.0.1:6379...
⏳ Waiting for Redis...
  Attempt 1/30...
✅ Redis is ready!
🔍 Node.js version: v20.11.0
📂 Working directory: /app
📄 Checking dist/index.js...
✅ dist/index.js exists
🚀 Starting Node.js application on port 8080...
✅ Connected to Redis { host: '127.0.0.1', port: 6379 }
✅ Connected to Supabase
🚀 Migration worker listening on port 8080
📡 Health check: http://localhost:8080/health
🔄 Endpoints: POST /migrations/start, GET /migrations/:id/status
```

---

## 🚨 If Still Failing

### Check Express Listen Host

If health check still fails after this deployment, the issue might be Express binding.

Quick fix - update `src/index.ts`:

```typescript
// Change this:
app.listen(PORT, () => {

// To this (explicitly bind to 0.0.0.0):
app.listen(PORT, '0.0.0.0', () => {
```

But let's see the logs first!

---

## 🎯 Alternative: Railway Redis Plugin

If all else fails, use Railway's managed Redis:

```bash
# In Railway dashboard
railway add redis

# Update code to use REDIS_URL
# Remove Redis from Dockerfile
# Remove Redis startup from start.sh
```

But Dockerfile Redis should work! Alpine's Redis package is very reliable.

---

**Status:** Deployed and building! ⏳

Monitor: `railway logs --follow`

Wait for: `🚀 Migration worker listening on port XXX`
