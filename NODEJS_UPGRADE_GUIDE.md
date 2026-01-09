# 🚀 Node.js Upgrade Guide: v18 → v22 LTS

## 📋 Prerequisites
- Windows 10/11
- Administrator privileges
- Internet connection
- Current Node.js v18.17.1 installed

## 📝 Step-by-Step Upgrade Process

### Step 1: Prepare Your System
```bash
# Run the upgrade preparation script
upgrade-nodejs.bat
```

This will:
- ✅ Check current Node.js version
- ✅ Backup package-lock.json files
- ✅ Clear npm cache
- ✅ Show download instructions

### Step 2: Download Node.js 22 LTS
1. **Open your web browser**
2. **Go to**: https://nodejs.org/
3. **Download**: `Windows Installer (.msi)` - **22.x.x LTS**
4. **File size**: ~30MB

### Step 3: Install Node.js 22
1. **Run the installer** as Administrator
2. **Follow the wizard**:
   - ✅ Accept license agreement
   - ✅ Use default installation path
   - ✅ Keep all features selected
   - ✅ Auto-install necessary tools
3. **Complete installation**

### Step 4: Restart Terminal/Command Prompt
```bash
# Close and reopen your command prompt/terminal
# Or open a new PowerShell/Command Prompt window
```

### Step 5: Verify Installation
```bash
# Check Node.js version
node --version
# Should show: v22.x.x

# Check npm version
npm --version
# Should show latest version
```

### Step 6: Complete Upgrade Process
```bash
# Continue the upgrade script (press any key when prompted)
# The script will automatically:
# - Verify Node.js 22 installation
# - Reinstall all dependencies
# - Clean npm cache
# - Test the installation
```

## 🔍 Verification Steps

### Test Frontend
```bash
cd frontend
npm run build
# Should complete without pdfjs-dist warnings
```

### Test Backend
```bash
cd backend
npm start
# Should start without errors
```

### Test Full Application
```bash
# Development mode
npm run dev

# Production mode
start-prod.bat
```

## 📊 Expected Results

### ✅ After Upgrade:
- Node.js: `v22.x.x`
- npm: Latest version
- No more pdfjs-dist engine warnings
- PDF functionality improved
- Better performance
- Latest security updates

### 📁 Files Created:
- `frontend/package-lock.json.backup`
- `backend/package-lock.json.backup`
- `package-lock.json.backup`

## 🛠️ Troubleshooting

### Issue: "node command not found"
```bash
# Check PATH environment variable
echo %PATH%

# Or reinstall Node.js and select "Add to PATH"
```

### Issue: Permission denied
```bash
# Run Command Prompt as Administrator
# Right-click → "Run as administrator"
```

### Issue: npm install fails
```bash
# Clear npm cache manually
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules
npm install
```

### Issue: Application doesn't start
```bash
# Check .env files are still valid
# Restart your IDE/text editor
# Try: npm run dev --reset-cache
```

## 🔄 Rollback (if needed)

If you need to rollback to Node.js 18:

1. **Download Node.js 18.x.x LTS** from nodejs.org
2. **Install it** (will replace Node.js 22)
3. **Restore backups**:
   ```bash
   copy frontend\package-lock.json.backup frontend\package-lock.json
   copy backend\package-lock.json.backup backend\package-lock.json
   copy package-lock.json.backup package-lock.json
   ```
4. **Reinstall dependencies**:
   ```bash
   npm install  # root
   cd backend && npm install && cd ..
   cd frontend && npm install && cd ..
   ```

## 📞 Support

If you encounter issues:
1. Check this guide first
2. Run `upgrade-nodejs.bat` again
3. Check Node.js installation logs
4. Verify all .env files are intact

## 🎯 Benefits of Node.js 22

- ✅ **pdfjs-dist compatibility** (no more warnings)
- ✅ **Better performance** (V8 engine improvements)
- ✅ **Security updates** (latest patches)
- ✅ **Long-term support** (until 2027)
- ✅ **Modern JavaScript features**
- ✅ **Better npm compatibility**

---

**Ready to upgrade? Run `upgrade-nodejs.bat` and follow the instructions!** 🚀
