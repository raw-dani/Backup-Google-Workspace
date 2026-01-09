# Google Workspace Email Backup - Startup Guide

## 🚀 Quick Start

### Production Mode (Recommended)
```bash
# Use the improved startup script
./start-prod-improved.bat
```

### Development Mode
```bash
# Start backend only
cd backend && npm run dev

# Start frontend only (in another terminal)
cd frontend && npm start
```

## 📋 Startup Scripts Comparison

### `start-prod.bat` (Original)
- ✅ Basic functionality
- ✅ Auto-kill existing processes
- ❌ Limited error handling
- ❌ No system checks
- ❌ Verbose error output

### `start-prod-improved.bat` (Recommended)
- ✅ **System requirements check** (Node.js, npm)
- ✅ **Enhanced process cleanup**
- ✅ **Database connection verification**
- ✅ **Better error handling**
- ✅ **Detailed progress reporting**
- ✅ **Graceful failure recovery**

## 🔧 Troubleshooting Common Issues

### 1. Database Connection Errors

**Problem:**
```
error: Database query failed {"error":"You have an error in your SQL syntax..."}
```

**Solutions:**
- ✅ **Already fixed**: Enhanced error handling in `databaseService.js`
- Check database configuration in `backend/.env`
- Ensure database server is running
- Verify database credentials

### 2. Port Already in Use

**Problem:**
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3001
```

**Solutions:**
- ✅ **Already handled**: Script auto-kills existing processes
- Manual cleanup: `netstat -ano | findstr :3001`
- Kill process: `taskkill /F /PID <PID>`

### 3. Frontend Build Failures

**Problem:**
```
ERROR: Failed to build frontend
```

**Solutions:**
- Clear npm cache: `cd frontend && npm cache clean --force`
- Reinstall dependencies: `cd frontend && rm -rf node_modules && npm install`
- Check Node.js version (18+ required)

### 4. Admin User Setup Issues

**Problem:**
```
ERROR: Failed to setup admin user
```

**Solutions:**
- ✅ **Normal behavior**: Script continues if admin already exists
- Manual setup: `cd backend && npm run setup:admin`
- Check database connectivity

## 📊 Database Schema Issues (FIXED)

### Problem
The original script showed many "Duplicate key name" errors because it tried to create indexes that already existed.

### Solution Applied
Enhanced error handling in `databaseService.js`:

```javascript
// Handle "already exists" errors gracefully
if (errorMsg.includes('already exists') ||
    errorMsg.includes('duplicate key name') ||
    errorMsg.includes('table') && errorMsg.includes('exists') ||
    errorMsg.includes('index') && errorMsg.includes('exists')) {
  logger.info('Index already exists, skipping', {
    command: command.trim().substring(0, 100) + '...'
  });
  continue; // Skip this command, continue with others
}
```

**Result:** Clean startup without error spam.

## 🎯 Production Configuration

### Environment Variables (`backend/.env`)

```env
# Database Configuration
DB_TYPE=mysql          # mysql, postgresql, or sqlite
DB_HOST=localhost
DB_PORT=3306
DB_NAME=gws_email_backup
DB_USER=root
DB_PASSWORD=

# Backup Configuration
BACKUP_INTERVAL=60     # Minutes between backups
MAX_CONCURRENT_USERS=3 # Users processed simultaneously
BATCH_SIZE=5          # Emails per batch
BATCH_DELAY=2000      # Milliseconds between batches

# Google OAuth (for real Gmail backup)
USE_REAL_GMAIL=true
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=path/to/service-account.json
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure database credentials
- [ ] Set up Google Service Account (if using real Gmail)
- [ ] Test database connection
- [ ] Verify file permissions
- [ ] Check available disk space
- [ ] Review backup intervals

## 🔍 Monitoring & Logs

### Log Locations
- Backend: `backend/logs/`
- Database: `backend/logs/database.log`
- Backup: `backend/logs/scheduled-backup.log`
- General: `logs/combined.log`

### Health Check
```
GET http://localhost:3001/health
```

### Debug Endpoints
```
GET http://localhost:3001/api/debug/emails/debug-stats
GET http://localhost:3001/api/debug/backup/config-debug
```

## 🚀 Performance Optimization

### For Large Deployments
- Increase `MAX_CONCURRENT_USERS` carefully (Google rate limits)
- Adjust `BATCH_SIZE` and `BATCH_DELAY` based on Gmail response times
- Monitor CPU and memory usage
- Consider database indexing optimization

### Anti-Detection Features
- ✅ Sequential email processing
- ✅ Configurable delays between batches
- ✅ Realistic human-like patterns
- ✅ Limited concurrent connections

## 🆘 Emergency Recovery

### If Server Won't Start
1. Kill all processes: `taskkill /F /IM node.exe`
2. Check ports: `netstat -ano | findstr :3001`
3. Verify database: Run the improved script
4. Check logs for specific errors

### Database Issues
1. Backup existing data
2. Reset database: Delete and recreate
3. Run setup scripts manually
4. Verify configuration

### Frontend Issues
1. Clear build cache: `cd frontend && npm run clean`
2. Rebuild: `cd frontend && npm run build`
3. Check browser console for errors

## 📞 Support

If issues persist:

1. Check the logs in `backend/logs/`
2. Verify all environment variables
3. Test database connectivity manually
4. Ensure all dependencies are installed
5. Check system resources (disk space, memory)

---

## 🎉 Summary

The improved startup script (`start-prod-improved.bat`) provides:

- **Robust error handling** - Continues despite minor issues
- **System verification** - Checks Node.js, npm, database
- **Clean output** - No more spam from duplicate index errors
- **Better diagnostics** - Clear progress reporting
- **Recovery options** - Handles various failure scenarios

**Use `start-prod-improved.bat` for reliable production deployments!** 🚀
