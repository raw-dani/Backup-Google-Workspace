# Google Workspace Email Backup Application Architecture

## Overview
This application provides on-premise email backup for Google Workspace domains using IMAP with OAuth2 Domain-Wide Delegation. It supports real-time backup via IMAP IDLE and scheduled hourly syncs, storing emails as immutable .eml files with metadata in a relational database.

## System Architecture

```mermaid
graph TB
    A[Google Workspace Domain] --> B[Service Account with DWD]
    B --> C[OAuth2 Token Generation]
    C --> D[IMAP Client]
    D --> E[imap.gmail.com:993]
    E --> F[Real-time Listener (IDLE)]
    E --> G[Scheduled Backup (Cron)]

    F --> H[Email Fetch & Store]
    G --> H

    H --> I[File Storage: /backup/domain/user/YYYY/MM/message-id.eml]
    H --> J[Database: Metadata & Search Index]

    K[Admin Web Interface (React)] --> L[REST API (Express.js)]
    L --> J
    L --> M[PST Export Service]
    M --> I
    M --> N[PST File Generation]

    O[Local Admin Auth] --> K
```

## Components

### Backend (Node.js/Express)
- **Authentication Service**: Handles Google OAuth2 service account authentication and XOAUTH2 token generation
- **IMAP Service**: Manages IMAP connections, IDLE listeners, and email fetching
- **Backup Service**: Orchestrates real-time and scheduled backups
- **Storage Service**: Handles .eml file storage and retrieval
- **Database Service**: Manages metadata storage and search indexing
- **PST Export Service**: Generates Outlook-compatible PST files from stored .eml files
- **API Service**: Provides REST endpoints for the admin interface
- **Worker Queue**: Handles background tasks (IMAP operations, PST generation)

### Frontend (React)
- **Admin Dashboard**: User interface for managing backups, searching emails, and initiating exports
- **Authentication**: Local admin login system

### Database (MySQL/PostgreSQL)
- Stores domain, user, email metadata, and attachment information
- Supports full-text search on email content

### File Storage
- Local filesystem with encrypted backup directory
- Hierarchical structure: /backup/domain/user/YYYY/MM/message-id.eml

## Security Considerations
- Service account JSON stored securely (environment variables or encrypted storage)
- Domain-Wide Delegation configured in Google Workspace admin console
- Local admin authentication with role-based access
- Audit logging for all admin actions
- Encrypted backup storage at filesystem level

## Deployment
- Single Linux server with Docker-ready containerization
- Node.js >=18 runtime
- Database server (MySQL/PostgreSQL)
- Cron jobs for scheduled backups
- Reverse proxy (nginx) for frontend serving

## Data Flow
1. Admin configures domain and service account
2. Application discovers users in domain
3. For each user: Generate OAuth2 token → Connect to IMAP → Start IDLE listener
4. On new email: Fetch RFC822 → Store .eml → Update database metadata
5. Scheduled job: Scan for missing UIDs → Fetch and store
6. Admin searches via web interface → Query database → Display results
7. PST export: Select criteria → Generate PST from .eml files → Download

## Scalability Notes
- Architecture supports multiple domains (current implementation: single domain)
- Connection pooling for IMAP (one per mailbox)
- Worker queues prevent blocking operations
- Database indexing for efficient search
- File storage can be mounted to network storage for larger deployments