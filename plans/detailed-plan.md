# Rencana Lengkap Pembuatan Aplikasi Backup Email Google Workspace

## Pendahuluan
Aplikasi ini adalah solusi backup email on-premise untuk Google Workspace yang menggunakan IMAP dengan OAuth2 Domain-Wide Delegation. Aplikasi ini mendukung backup real-time melalui IMAP IDLE dan sinkronisasi terjadwal setiap jam, menyimpan email sebagai file .eml yang immutable dengan metadata di database relasional.

## Arsitektur Sistem

### Komponen Utama
1. **Backend (Node.js/Express)**
   - Layanan autentikasi OAuth2 Google
   - Layanan IMAP untuk koneksi dan fetching email
   - Layanan backup (real-time dan terjadwal)
   - Layanan penyimpanan file .eml
   - Layanan database untuk metadata
   - Layanan ekspor PST
   - API REST untuk interface admin
   - Worker queue untuk tugas background

2. **Frontend (React)**
   - Dashboard admin untuk manajemen backup
   - Interface pencarian dan pembacaan email
   - Fitur ekspor PST
   - Autentikasi admin lokal

3. **Database (MySQL/PostgreSQL)**
   - Skema relasional untuk domain, user, email, dan attachment
   - Indeks full-text untuk pencarian

4. **Penyimpanan File**
   - Sistem file lokal dengan struktur hierarkis
   - Enkripsi pada level direktori backup

## Struktur Folder

### Backend
```
backend/
├── src/
│   ├── controllers/     # Handler untuk endpoint API
│   ├── services/        # Logika bisnis utama
│   │   ├── auth/        # Autentikasi OAuth2
│   │   ├── imap/        # Layanan IMAP
│   │   ├── backup/      # Layanan backup
│   │   ├── storage/     # Penyimpanan file
│   │   ├── database/    # Interaksi database
│   │   ├── pst/         # Ekspor PST
│   │   └── queue/       # Worker queue
│   ├── models/          # Model database
│   ├── routes/          # Definisi route API
│   ├── middleware/      # Middleware Express
│   ├── utils/           # Utility functions
│   ├── workers/         # Worker scripts
│   └── config/          # Konfigurasi aplikasi
├── package.json
├── Dockerfile
└── docker-compose.yml
```

### Frontend
```
frontend/
├── src/
│   ├── components/      # Komponen React
│   ├── pages/           # Halaman aplikasi
│   ├── services/        # API calls
│   ├── hooks/           # Custom hooks
│   ├── utils/           # Utility functions
│   └── styles/          # CSS/Styling
├── public/
├── package.json
└── Dockerfile
```

## Skema Database

### Tabel Utama
```sql
-- Domain Google Workspace
CREATE TABLE domains (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User dalam domain
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER REFERENCES domains(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  last_uid INTEGER DEFAULT 0,
  status ENUM('active', 'inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Metadata email
CREATE TABLE emails (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  message_id VARCHAR(255) UNIQUE NOT NULL,
  subject TEXT,
  from_email VARCHAR(255),
  to_email TEXT,
  date TIMESTAMP,
  eml_path VARCHAR(500),
  size INTEGER,
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FULLTEXT(subject, from_email, to_email)
);

-- Attachment dalam email
CREATE TABLE attachments (
  id SERIAL PRIMARY KEY,
  email_id INTEGER REFERENCES emails(id),
  filename VARCHAR(255),
  mime_type VARCHAR(100),
  size INTEGER
);
```

## Alur Kerja Utama

### 1. Setup Awal
- Konfigurasi service account Google dengan Domain-Wide Delegation
- Setup database dan struktur folder
- Konfigurasi domain dan discovery user

### 2. Backup Real-time (IMAP IDLE)
- Untuk setiap user: generate token OAuth2 → koneksi IMAP → start IDLE
- Deteksi email baru → fetch RFC822 → simpan .eml → update database
- Auto-reconnect setiap 25 menit
- Ignore event delete/expunge

### 3. Backup Terjadwal (Cron)
- Jalankan setiap jam
- Scan mailbox untuk UID yang missing
- Prevent duplikasi menggunakan Message-ID
- Fail-safe jika IDLE miss events

### 4. Pencarian dan Pembacaan
- Admin login → dashboard
- Pencarian berdasarkan subject, from, to, content
- Tampilkan hasil dengan pagination
- Baca email (HTML/text) dan download attachment

### 5. Ekspor PST
- Pilih kriteria (user, date range)
- Generate PST dari file .eml tersimpan
- Background processing via worker queue
- Download PST yang sudah jadi

## Teknologi dan Dependensi

### Backend
- Node.js >=18
- Express.js untuk API
- google-auth-library untuk OAuth2
- imap untuk koneksi IMAP
- mailparser untuk parsing email
- mysql2/pg untuk database
- bull untuk worker queue
- ioredis untuk Redis
- bcrypt/jsonwebtoken untuk auth admin
- winston untuk logging
- node-cron untuk scheduled jobs

### Frontend
- React dengan hooks
- Axios untuk API calls
- React Router untuk routing
- Material-UI atau Bootstrap untuk UI
- React Query untuk state management

## Keamanan
- Service account JSON disimpan aman (env vars atau encrypted storage)
- Domain-Wide Delegation dikonfigurasi di Google Workspace admin
- Autentikasi admin lokal dengan RBAC
- Audit logging untuk semua aksi admin
- Enkripsi direktori backup pada level filesystem
- HTTPS untuk semua komunikasi

## Deployment
- Server Linux tunggal
- Docker container untuk backend dan frontend
- Database server terpisah (MySQL/PostgreSQL)
- Reverse proxy (nginx) untuk serving frontend
- Cron jobs untuk backup terjadwal
- Monitoring dan logging

## Langkah Implementasi

1. **Setup Proyek dan Struktur Folder**
   - Inisialisasi backend dengan package.json
   - Inisialisasi frontend dengan create-react-app
   - Setup Docker dan docker-compose

2. **Implementasi Database**
   - Buat skema database
   - Setup koneksi database
   - Buat migration scripts

3. **Implementasi Autentikasi OAuth2**
   - Service untuk generate XOAUTH2 token
   - Impersonasi user via service account
   - Error handling untuk token expiry

4. **Implementasi Layanan IMAP**
   - Koneksi IMAP dengan OAuth2
   - IDLE listener untuk real-time backup
   - Fetching dan parsing email
   - Connection pooling

5. **Implementasi Layanan Backup**
   - Real-time backup via IDLE
   - Scheduled backup via cron
   - Duplicate prevention
   - Error handling dan retries

6. **Implementasi API REST**
   - Endpoint untuk manajemen domain/user
   - Endpoint pencarian email
   - Endpoint ekspor PST
   - Authentication middleware

7. **Implementasi Frontend**
   - Dashboard admin dengan login
   - Komponen pencarian email
   - Viewer email dengan attachment download
   - Form ekspor PST

8. **Implementasi Ekspor PST**
   - Library untuk generate PST dari .eml
   - Worker queue untuk processing
   - Progress tracking
   - File cleanup setelah download

9. **Testing dan QA**
   - Unit tests untuk services
   - Integration tests untuk API
   - End-to-end tests untuk UI
   - Performance testing

10. **Dokumentasi dan Deployment**
    - README dengan setup instructions
    - Docker deployment
    - Monitoring setup
    - Backup dan recovery procedures

## Timeline Estimasi
- Fase 1: Setup dan arsitektur (1 minggu)
- Fase 2: Backend core (IMAP, OAuth2, database) (2 minggu)
- Fase 3: Backup services (real-time dan scheduled) (1 minggu)
- Fase 4: API dan frontend (2 minggu)
- Fase 5: PST export dan testing (1 minggu)
- Fase 6: Deployment dan dokumentasi (1 minggu)

Total: 8 minggu untuk implementasi penuh dengan testing.

## Risiko dan Mitigasi
- **Rate limiting Google**: Implementasi exponential backoff dan connection pooling
- **Large mailboxes**: Incremental backup dengan UID tracking
- **Storage growth**: Monitoring disk usage dan cleanup policies
- **IMAP connection issues**: Auto-reconnect dengan retry logic
- **PST generation performance**: Background processing dan progress tracking

## Kesimpulan
Plan ini mencakup semua aspek yang diperlukan untuk membangun aplikasi backup email Google Workspace yang production-ready. Arsitektur modular memungkinkan scalability dan maintainability, dengan fokus pada keamanan dan reliability untuk penggunaan enterprise.