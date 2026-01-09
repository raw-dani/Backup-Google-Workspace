import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000, // Increased to 60 seconds for backup operations
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid
      localStorage.removeItem('token');
      delete api.defaults.headers.common['Authorization'];
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  login: (credentials) => api.post('/auth/login', credentials),
  logout: () => api.post('/auth/logout'),
  getMe: () => api.get('/auth/me'),
  changePassword: (data) => api.post('/auth/change-password', data),
  setup: (data) => api.post('/auth/setup', data),
  // Admin Management (Super Admin only)
  getAdminList: () => api.get('/auth/admin-list'),
  createAdmin: (data) => api.post('/auth/admin-create', data),
  resetAdminPassword: (data) => api.post('/auth/admin-reset-password', data),
  updateAdminRole: (data) => api.put('/auth/admin-update-role', data),
  deleteAdmin: (data) => api.post('/auth/admin-delete', data),
};

// Domains API
export const domainsAPI = {
  getDomains: (params) => api.get('/domains', { params }),
  getDomain: (id) => api.get(`/domains/${id}`),
  createDomain: (data) => api.post('/domains', data),
  updateDomain: (id, data) => api.put(`/domains/${id}`, data),
  deleteDomain: (id) => api.delete(`/domains/${id}`),
  discoverUsers: (id, data) => api.post(`/domains/${id}/discover-users`, data),
};

// Users API
export const usersAPI = {
  getUsers: (params) => api.get('/users', { params }),
  getUser: (id) => api.get(`/users/${id}`),
  updateUserStatus: (id, data) => api.patch(`/users/${id}/status`, data),
  connectUser: (id) => api.post(`/users/${id}/connect`),
  disconnectUser: (id) => api.post(`/users/${id}/disconnect`),
  runManualBackup: (id) => api.post(`/users/${id}/backup`),
  getUserImapStatus: (id) => api.get(`/users/${id}/imap-status`),
  getUserStats: (id, params) => api.get(`/users/${id}/stats`, { params }),
  deleteUser: (id) => api.delete(`/users/${id}`),
};

// Emails API
export const emailsAPI = {
  searchEmails: (params) => api.get('/emails/search', { params }),
  getEmail: (id) => api.get(`/emails/${id}`),
  getEmailById: (id) => api.get(`/emails/${id}`), // Alias for backward compatibility
  getEmailContent: (id) => api.get(`/emails/${id}/content`, { responseType: 'blob' }),
  getEmailPreview: (id) => api.get(`/emails/${id}/preview`),
  getEmailAttachments: (id) => api.get(`/emails/${id}/attachments`),
  getAttachmentContent: (emailId, attachmentId) => api.get(`/emails/${emailId}/attachments/${attachmentId}?download=false`),
  downloadAttachment: (emailId, attachmentId) => api.get(`/emails/${emailId}/attachments/${attachmentId}?download=true`, { responseType: 'blob' }),
  getEmailStats: (params) => api.get('/emails/stats/overview', { params }),
  deleteEmail: (id) => api.delete(`/emails/${id}`),
  bulkDeleteEmails: (emailIds) => api.delete('/emails/bulk', { data: { emailIds } }),
};

// Exports API
export const exportsAPI = {
  createExport: (data) => api.post('/exports', data),
  getExports: (params) => api.get('/exports', { params }),
  getExport: (id) => api.get(`/exports/${id}`),
  downloadExport: (id) => api.get(`/exports/${id}/download`, { responseType: 'blob' }),
  deleteExport: (id) => api.delete(`/exports/${id}`),
  getExportStats: () => api.get('/exports/stats/overview'),
  retryExport: (id) => api.post(`/exports/${id}/retry`),
};

export default api;
