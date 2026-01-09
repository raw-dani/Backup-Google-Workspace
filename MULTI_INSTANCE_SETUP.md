# Multi-Instance Setup Guide

Best practices untuk menjalankan multiple instances dari GWS Email Backup di satu komputer Windows dengan MySQL (WampServer).

## Arsitektur

```
Windows Server
├── WampServer MySQL
│   ├── Database: gws_backup_atonergi
│   ├── Database: gws_backup_rejaton
│   └── Database: gws_backup_domain3
│
├── Instance 1 (atonergi)
│   ├── Backend: http://localhost:3001
│   ├── Frontend: http://localhost:8080
│   └── Backup: d:\backup\atonergi.com
│
├── Instance 2 (rejaton)
│   ├── Backend: http://localhost:3002
│   ├── Frontend: http://localhost:8081
│   └── Backup: d:\backup\rejaton.com
│
└── Instance 3 (domain3)
    ├── Backend: http://localhost:3003
    ├── Frontend: http://localhost:8082
    └── Backup: d:\backup\domain3.com
```

## Port Allocation

| Instance | Backend Port | Frontend Port | Database |
|----------|-------------|---------------|----------|
| atonergi | 3001 | 8080 | gws_backup_atonergi |
| rejaton | 3002 | 8081 | gws_backup_rejaton |
| domain3 | 3003 | 8082 | gws_backup_domain3 |

## Cara Membuat Instance Baru

### Otomatis (Recommended)

1. Jalankan script:
   ```batch
   cd d:\PWA\backup-gws\scripts
   create-instance.bat
   ```

2. Ikuti instruksi:
   ```
   Enter instance name: atonergi
   Enter backend port (default: 3001): 3001
   Enter frontend port (default: 8080): 8080
   Enter database name: gws_backup_atonergi
   Enter MySQL user: root
   Enter MySQL password: ********
   ```

3. Script akan:
   - Buat folder `instances\atonergi`
   - Copy semua file
   - Update konfigurasi (.env)
   - Buat database di MySQL
   - Build frontend

### Manual

1. Copy folder utama:
   ```batch
   xcopy /E /I d:\PWA\backup-gws d:\PWA\backup-gws\instances\atonergi
   ```

2. Update `.env` di `backend\`:
   ```env
   PORT=3001
   DB_NAME=gws_backup_atonergi
   DB_USER=root
   DB_PASSWORD=your_password
   ```

3. Update `.env` di `frontend\`:
   ```env
   REACT_APP_API_URL=http://localhost:3001
   ```

4. Setup database:
   ```sql
   CREATE DATABASE gws_backup_atonergi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

5. Build frontend:
   ```batch
   cd frontend
   npm run build
   ```

## Menjalankan sebagai Windows Service (NSSM)

Install service untuk auto-start saat boot:

```batch
REM Install service
nssm install GWSBackup_atonergi "d:\PWA\backup-gws\instances\atonergi\node_modules\nodebin\node.exe" "src\index.js"
nssm set GWSBackup_atonergi AppDirectory "d:\PWA\backup-gws\instances\atonergi\backend"
nssm set GWSBackup_atonergi DisplayName "GWS Backup - atonergi"
nssm set GWSBackup_atonergi Start SERVICE_AUTO_START
nssm set GWSBackup_atonergi AppStdout "d:\PWA\backup-gws\instances\atonergi\logs\service.log"
nssm set GWSBackup_atonergi AppStderr "d:\PWA\backup-gws\instances\atonergi\logs\error.log"

REM Start service
nssm start GWSBackup_atonergi
```

## Backup Storage

Setiap instance punya folder backup sendiri:

```
d:\backup\
├── atonergi.com\
│   ├── user1@atonergi.com\
│   └── user2@atonergi.com\
├── rejaton.com\
│   └── user1@rejaton.com\
└── domain3.com\
    └── user1@domain3.com\
```

## Monitoring

Cek status service:
```batch
nssm status GWSBackup_atonergi
nssm status GWSBackup_rejaton
nssm status GWSBackup_domain3
```

Cek log:
```batch
type d:\PWA\backup-gws\instances\atonergi\logs\app.log
```

## Keuntungan Multi-Instance

1. **Isolation** - Satu instance crash tidak affect instance lain
2. **Resource Management** - Masing-masing instance bisa dikontrol resource-nya
3. **Easy Migration** - Pindah ke server lain lebih mudah
4. **Security** - Service account terpisah per domain
5. **Backup** - Backup/restore per domain

## Troubleshooting

### Port Already in Use
```batch
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

### MySQL Connection Failed
- Pastikan WampServer running
- Cek credentials di .env
- Cek MySQL user permissions

### Frontend Tidak Bisa Connect ke Backend
- Pastikan backend running di port yang benar
- Cek REACT_APP_API_URL di frontend/.env
- Hard refresh browser (Ctrl+Shift+R)
