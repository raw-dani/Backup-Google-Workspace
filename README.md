# Google Workspace Email Backup System

A production-ready on-premise email backup application for Google Workspace that provides real-time and scheduled email backups using IMAP with OAuth2 Domain-Wide Delegation.

## Features

- **Real-time Backup**: IMAP IDLE listener for instant email capture
- **Scheduled Backup**: Hourly cron job as fail-safe
- **Immutable Storage**: Emails stored as .eml files, unaffected by Gmail deletions
- **Web Interface**: React-based admin dashboard for search and management
- **PST Export**: Generate Outlook-compatible PST files from stored emails
- **Multi-instance Support**: Run multiple domain instances on one server
- **Admin Management**: Multi-user support with role-based access control
- **Security**: OAuth2 authentication, encrypted storage, audit logging

## Admin Roles

| Role | Access Level |
|------|-------------|
| **super_admin** | Full access + admin management |
| **admin** | Full access (except admin management) |
| **viewer** | Read only - Dashboard, Emails, Exports only |

## Quick Start

### Windows Local Development

```batch
# Run automated setup
start-windows.bat

# Start development servers
start-dev.bat
```

**Access:** http://localhost:3001  
**Default Login:** admin / admin123

### Create New Instance (Multi-Domain)

```batch
cd scripts
create-instance.bat
```

See [MULTI_INSTANCE_SETUP.md](MULTI_INSTANCE_SETUP.md) for detailed multi-instance guide.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Google        │    │   Service       │    │   IMAP         │
│   Workspace     │◄──►│   Account       │◄──►│   Connection    │
│   Domain        │    │   (OAuth2 DWD)  │    │   (imap.gmail)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Admin Web     │    │   REST API      │    │   Email         │
│   Interface     │◄──►│   (Express.js)  │◄──►│   Storage       │
│   (React)       │    │                 │    │   (.eml files)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   PST Export    │    │   Worker Queue  │    │   Database      │
│   Service       │    │   (Bull/Redis)  │    │   (MySQL/PG)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Prerequisites

- Node.js >= 18.0.0
- MySQL 8.0+ or PostgreSQL 13+
- Redis 6.0+ (optional for production, in-memory for dev)
- Windows Server 2016+ or Windows 10/11
- WampServer (for MySQL on Windows)

## Google Workspace Setup

### 1. Create Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Workspace APIs:
   - Admin SDK API
   - Gmail API
4. Create a Service Account:
   - IAM & Admin → Service Accounts → Create Service Account
   - Grant appropriate roles
   - Create and download JSON key file

### 2. Enable Domain-Wide Delegation

1. In Google Workspace Admin Console:
   - Security → API controls → Domain-wide delegation
   - Add the service account client ID
   - Add scope: `https://mail.google.com/`

### 3. Grant Service Account Access

1. In Google Workspace Admin Console:
   - Users → Select user → Security → Manage API client access
   - Add service account client ID
   - Add scope: `https://mail.google.com/`

## Installation

### Windows (Recommended)

```batch
# Automated setup
start-windows.bat

# Start development
start-dev.bat
```

### Manual Setup

```batch
# Backend
cd backend
npm install
npm run setup:db

# Frontend
cd ../frontend
npm install
npm run build
```

## Configuration

### Backend (.env)

```env
# Server
NODE_ENV=development
PORT=3001

# Database (MySQL with WampServer)
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=gws_backup_atonergi
DB_USER=root
DB_PASSWORD=your_password

# Google OAuth2
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account-key.json

# JWT
JWT_SECRET=your-super-secure-jwt-key

# File Storage
BACKUP_DIR=./backup
```

### Frontend (.env)

```env
REACT_APP_API_URL=http://localhost:3001
```

## Running the Application

### Development

```batch
start-dev.bat
```

### Production

```batch
start-prod.bat
```

### Windows Service (NSSM)

```batch
# Install service
nssm install GWSBackup "path\to\node.exe" "src\index.js"
nssm set GWSBackup AppDirectory "path\to\backend"
nssm set GWSBackup DisplayName "GWS Email Backup"
nssm set GWSBackup Start SERVICE_AUTO_START

# Start service
nssm start GWSBackup
```

## API Documentation

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Admin login |
| POST | /api/auth/logout | Admin logout |
| GET | /api/auth/me | Get current user |
| POST | /api/auth/change-password | Change password |
| POST | /api/auth/setup | Initial admin setup (one-time) |

### Admin Management (super_admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/auth/admin-list | List all admins |
| POST | /api/auth/admin-create | Create new admin |
| POST | /api/auth/admin-reset-password | Reset admin password |
| PUT | /api/auth/admin-update-role | Update admin role |
| POST | /api/auth/admin-delete | Delete admin |

### Domains

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/domains | List domains |
| POST | /api/domains | Create domain |
| DELETE | /api/domains/:id | Delete domain |
| POST | /api/domains/:id/discover-users | Discover domain users |

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/users | List users |
| POST | /api/users | Create user |
| PATCH | /api/users/:id/status | Update user status |
| POST | /api/users/:id/connect | Connect IMAP |
| DELETE | /api/users/:id | Delete user |

### Emails

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/emails/search | Search emails |
| GET | /api/emails/:id | Get email details |
| GET | /api/emails/:id/content | Download EML file |

### Exports

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/exports | Create export job |
| GET | /api/exports | List exports |
| GET | /api/exports/:id/download | Download export |

### Backup

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/backup/manual/:userId | Start manual backup |
| GET | /api/backup/status/:userId | Get backup status |

## Multi-Instance Setup

See [MULTI_INSTANCE_SETUP.md](MULTI_INSTANCE_SETUP.md) for detailed multi-domain setup.

### Quick Instance Creation

```batch
cd scripts
create-instance.bat
```

### Port Allocation

| Instance | Backend Port | Frontend Port | Database |
|----------|-------------|---------------|----------|
| atonergi | 3001 | 8080 | gws_backup_atonergi |
| rejaton | 3002 | 8081 | gws_backup_rejaton |
| domain3 | 3003 | 8082 | gws_backup_domain3 |

## Usage

### Initial Setup

1. Access http://localhost:3001
2. Login with default credentials: admin / admin123
3. **Change password immediately**

### Adding Domains and Users

1. Go to **Domains** → Add your Google Workspace domain
2. Click **Discover Users** to find all users
3. Activate users to start IMAP backup connections

### Creating Additional Admins

1. Login as **super_admin**
2. Go to **Admin Management**
3. Click **Add Admin**
4. Select role (super_admin/admin/viewer)

### Searching Emails

1. Go to **Emails** section
2. Use filters to search by:
   - Subject
   - Sender
   - Recipient
   - Date range

### Exporting Emails

1. Go to **Exports** section
2. Select user and date range
3. Choose format (EML or PST-Compatible)
4. Download when complete

## Troubleshooting

### Common Issues

#### IMAP Connection Failed
```
unauthorized_client: Client is unauthorized
```
- Verify service account permissions
- Check domain-wide delegation setup
- Ensure Gmail API is enabled

#### Port Already in Use
```batch
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

#### Database Connection Failed
- Ensure WampServer/MySQL is running
- Check credentials in .env
- Verify database exists

#### Frontend Can't Connect to Backend
- Check REACT_APP_API_URL in frontend/.env
- Verify backend is running
- Hard refresh browser (Ctrl+Shift+R)

### View Logs

```batch
type backend\logs\auth.log
type backend\logs\imap.log
type backend\logs\error.log
```

## Security

### Change Default Credentials

```bash
# Via API
curl -X POST http://localhost:3001/api/auth/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword": "admin123", "newPassword": "your-secure-password"}'
```

### File Structure

```
gws-email-backup/
├── backend/
│   ├── data/              # Database files
│   ├── logs/              # Application logs
│   ├── backup/            # Email storage
│   └── src/
├── frontend/
│   ├── build/             # Production build
│   └── src/
├── scripts/
│   ├── create-instance.bat # Multi-instance setup
│   └── fix-admin-role.js   # Fix MySQL role constraint
├── instances/             # Multi-instance deployments
├── start-windows.bat      # Setup script
├── start-dev.bat          # Development start
├── start-prod.bat         # Production start
├── MULTI_INSTANCE_SETUP.md
└── README.md
```

## Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request

## License

MIT License - see LICENSE file for details.
