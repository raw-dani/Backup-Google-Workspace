# Panduan Lengkap Setup Google Service Account untuk Email Backup

## 📋 **Pertanyaan Utama & Jawaban**

### ❓ **Apakah Service Account Email Harus Menggunakan Domain yang Sama dengan Email yang Ingin Dibackup?**

**Jawaban: TIDAK, boleh berbeda domain!**

Service Account adalah akun Google yang terpisah dari domain Gmail user biasa. Service account menggunakan format email:
```
nama-service@nama-project.iam.gserviceaccount.com
```

**Contoh:**
- ✅ Service Account: `gws-backup@my-backup-project.iam.gserviceaccount.com`
- ✅ Target Backup: `user@company.com`, `admin@different-domain.org`

### ❓ **Apakah Harus Menggunakan Satu Admin Console atau Bisa Beda Admin Console?**

**Jawaban: BOLEH berbeda admin console, tapi dengan batasan!**

#### ✅ **Opsi 1: Service Account di Admin Console yang Sama (Recommended)**
- Service Account dibuat di Google Cloud Project yang sama dengan Workspace domain
- Setup lebih sederhana
- Manajemen lebih mudah

#### ✅ **Opsi 2: Service Account di Admin Console yang Berbeda**
- Service Account dari project berbeda
- Perlu setup cross-domain delegation
- Lebih kompleks tapi lebih fleksibel

---

## 🚀 **Panduan Setup Step-by-Step**

### **Langkah 1: Persiapan Google Cloud Project**

#### **1.1 Buat atau Pilih Google Cloud Project**
```bash
# Buka Google Cloud Console
# https://console.cloud.google.com/
```

1. **Pilih Project** atau **Buat Project Baru**
2. **Catat Project ID** (contoh: `my-email-backup-2024`)
3. **Enable Billing** jika belum ada

#### **1.2 Enable Required APIs**
Di Google Cloud Console → APIs & Services → Library:

**Wajib Enable:**
- ✅ **Admin SDK API** - Untuk domain-wide delegation dan user management
- ✅ **Gmail API** - Untuk akses IMAP email backup

**Opsional:**
- 🔄 **Groups Migration API** - Untuk migrasi email ke Google Groups
- 🔄 **Groups Settings API** - Untuk manajemen settings groups
- 🔄 **Cloud Identity API** - Untuk identity management advanced
- 🔄 **Google Drive API** - Jika perlu backup attachments
- 🔄 **Google Cloud Storage API** - Jika perlu cloud storage

---

### **Langkah 2: Buat Service Account**

#### **2.1 Buat Service Account**
```
Google Cloud Console → IAM & Admin → Service Accounts → Create Service Account
```

**Form Input:**
- **Service account name**: `gws-email-backup`
- **Service account ID**: `gws-email-backup` (auto-generated)
- **Description**: `Google Workspace Email Backup Service Account`

#### **2.2 Set Role untuk Service Account**
**Grant this service account access to project** (optional):
- **Role**: `Editor` atau `Viewer` (minimal untuk project access)

#### **2.3 Buat dan Download Key**
1. **Klik service account** yang baru dibuat
2. **Keys tab** → **Add Key** → **Create new key**
3. **Key type**: `JSON` (recommended)
4. **Download file**: `nama-project-xxx.json`
5. **Simpan file** di lokasi aman: `./backend/service-account-key.json`

---

### **Langkah 3: Setup Domain-Wide Delegation**

#### **3.1 Enable Domain-Wide Delegation**
```
Service Account Details → Advanced settings → Enable Google Workspace Domain-wide Delegation
```

**Form Input:**
- ✅ **Enable Google Workspace Domain-wide Delegation**
- **Product name for the consent screen**: `GWS Email Backup`

#### **3.2 Catat Client ID**
**Copy Client ID** dari service account:
```
Client ID: 123456789012345678901
```

---

### **Langkah 4: Konfigurasi Google Workspace Admin Console**

#### **4.1 Akses Admin Console**
```
https://admin.google.com/
```

**Login sebagai Super Admin**

#### **4.2 Setup Domain-Wide Delegation**
```
Security → API controls → Domain-wide delegation
```

**Klik "Manage Domain Wide Delegation"**

#### **4.3 Add Service Account**
**Add new entry:**

| Field | Value |
|-------|--------|
| **Client ID** | `123456789012345678901` (dari langkah 3.2) |
| **OAuth scopes** | `https://mail.google.com/` |

**Klik "Authorize"**

---

### **Langkah 5: Grant Mailbox Access (Opsional)**

#### **5.1 Untuk User Tertentu (Recommended)**
```
Users → Pilih User → Security → Manage API client access
```

**Add API client access:**
- **Client Name**: Service Account Client ID
- **One or More API Scopes**: `https://mail.google.com/`

#### **5.2 Untuk Semua User (Advanced)**
Jika ingin akses semua mailbox, gunakan domain-wide delegation saja.

---

### **Langkah 6: Konfigurasi Aplikasi**

#### **6.1 Update Environment Variables**
```env
# backend/.env
GOOGLE_SERVICE_ACCOUNT_EMAIL=gws-email-backup@my-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account-key.json
```

#### **6.2 Test Koneksi**
```bash
# Test OAuth2 token generation
cd backend
node -e "
const { oauth2Service } = require('./src/services/auth/oauth2Service');
oauth2Service.initialize().then(() => {
  console.log('✅ Service Account configured correctly');
}).catch(err => {
  console.error('❌ Configuration error:', err.message);
});
"
```

---

## 🔄 **Skenario Multi-Domain Setup**

### **Skenario 1: Backup Multiple Domains**
```
Domain A: company-a.com
Domain B: company-b.com
Service Account: backup@central-project.iam.gserviceaccount.com
```

**Setup:**
1. **Satu Service Account** di satu Google Cloud Project
2. **Domain-wide delegation** untuk setiap domain
3. **Konfigurasi aplikasi** untuk multiple domains

### **Skenario 2: Separate Projects per Domain**
```
Domain A: backup-a@project-a.iam.gserviceaccount.com
Domain B: backup-b@project-b.iam.gserviceaccount.com
```

**Setup:**
1. **Service Account terpisah** per domain
2. **Project terpisah** per domain
3. **Konfigurasi aplikasi** dengan multiple service accounts

---

## 🔧 **Troubleshooting Setup**

### **Error: "Invalid Scope"**
```
Solution: Pastikan scope https://mail.google.com/ sudah ditambahkan
```

### **Error: "Access Denied"**
```
Solution: Periksa domain-wide delegation di Admin Console
```

### **Error: "Service Account Not Found"**
```
Solution: Periksa GOOGLE_SERVICE_ACCOUNT_EMAIL di .env
```

### **Error: "Key File Not Found"**
```
Solution: Periksa path GOOGLE_SERVICE_ACCOUNT_KEY_FILE
```

---

## 📊 **Perbandingan Setup Options**

| Aspek | Same Domain | Different Domain |
|-------|-------------|------------------|
| **Complexity** | 🟢 Simple | 🟡 Medium |
| **Security** | 🟢 Isolated | 🟡 Cross-domain |
| **Management** | 🟢 Easy | 🟡 Complex |
| **Cost** | 🟢 Same | 🟡 Multiple projects |
| **Scalability** | 🟡 Limited | 🟢 High |

---

## 🚀 **Quick Setup Script**

### **Bash Script untuk Setup Otomatis**
```bash
#!/bin/bash

# Variables
PROJECT_ID="my-email-backup-project"
SERVICE_ACCOUNT_NAME="gws-email-backup"
DOMAIN="your-domain.com"

# Create service account
gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME \
    --description="GWS Email Backup Service Account" \
    --display-name="GWS Email Backup"

# Create key
gcloud iam service-accounts keys create ./service-account-key.json \
    --iam-account=$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com

# Enable domain-wide delegation
gcloud iam service-accounts update $SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com \
    --enable-domain-wide-delegation

echo "✅ Service Account created successfully!"
echo "📝 Client ID: $(gcloud iam service-accounts describe $SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com --format='value(uniqueId)')"
echo "📁 Key file: ./service-account-key.json"
echo "🔗 Next: Configure domain-wide delegation in Google Workspace Admin Console"
```

---

## 📞 **Support & Resources**

### **Official Documentation**
- [Google Service Accounts](https://cloud.google.com/iam/docs/service-accounts)
- [Domain-wide Delegation](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Gmail API Scopes](https://developers.google.com/gmail/api/auth/scopes)

### **Troubleshooting**
- [GCP Support](https://cloud.google.com/support)
- [Workspace Admin Help](https://support.google.com/a)

### **Best Practices**
- 🔐 **Rotate keys** regularly (90 days)
- 👥 **Limit access** to minimum required
- 📊 **Monitor usage** di GCP console
- 🔄 **Backup configurations** regularly

---

## ✅ **Checklist Setup Lengkap**

### **Pre-Setup**
- [ ] Google Cloud Project created
- [ ] Billing enabled
- [ ] APIs enabled (Admin SDK, Gmail API)

### **Service Account**
- [ ] Service account created
- [ ] JSON key downloaded
- [ ] Domain-wide delegation enabled
- [ ] Client ID noted

### **Workspace Configuration**
- [ ] Domain-wide delegation configured
- [ ] OAuth scope added: `https://mail.google.com/`
- [ ] User access granted (if needed)

### **Application Setup**
- [ ] Environment variables configured
- [ ] Service account key file placed
- [ ] Application restarted
- [ ] Connection test successful

### **Testing**
- [ ] IMAP connection works
- [ ] Email backup functional
- [ ] PST export working
- [ ] Admin interface accessible

---

**🎉 Setup selesai! Service Account Anda siap untuk backup email Google Workspace.**

**Pertanyaan lebih lanjut? Lihat dokumentasi atau hubungi support!** 🚀