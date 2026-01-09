const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../services/database/databaseService');
const winston = require('winston');

const router = express.Router();
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/auth.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user
    const users = await query(
      'SELECT id, username, password_hash, role FROM admin_users WHERE username = ?',
      [username]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Update last login
    await query(
      'UPDATE admin_users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Log successful login
    await logAuditAction(user.id, 'login', null, null, req.ip);

    logger.info('Admin login successful', { username, ip: req.ip });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error('Login failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout endpoint
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await logAuditAction(req.user.id, 'logout', null, null, req.ip);
    logger.info('Admin logout', { username: req.user.username });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const users = await query(
      'SELECT id, username, role, last_login FROM admin_users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: users[0] });
  } catch (error) {
    logger.error('Failed to get user info', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current user
    const users = await query(
      'SELECT password_hash FROM admin_users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, users[0].password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await query(
      'UPDATE admin_users SET password_hash = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    );

    await logAuditAction(req.user.id, 'change_password', 'admin_users', req.user.id, req.ip);

    logger.info('Password changed', { username: req.user.username });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Failed to change password', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create initial admin user (one-time setup)
router.post('/setup', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if any admin user exists
    const existingUsers = await query('SELECT COUNT(*) as count FROM admin_users');
    if (existingUsers[0].count > 0) {
      return res.status(403).json({ error: 'Admin user already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create admin user
    await query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hashedPassword, 'admin']
    );

    logger.info('Initial admin user created', { username });

    res.json({ message: 'Admin user created successfully' });
  } catch (error) {
    logger.error('Failed to create admin user', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN MANAGEMENT ENDPOINTS (Super Admin Only)
// ============================================

// Middleware to check if user is super_admin
const requireSuperAdmin = async (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only super_admin can perform this action' });
  }
  next();
};

// List all admin users
router.get('/admin-list', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const admins = await query(
      'SELECT id, username, role, last_login, created_at FROM admin_users ORDER BY created_at DESC'
    );
    
    res.json({ admins });
  } catch (error) {
    logger.error('Failed to list admin users', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new admin user
router.post('/admin-create', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Validate role - super_admin can create any role
    const validRoles = ['super_admin', 'admin', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be super_admin, admin, or viewer' });
    }

    // Check if username already exists
    const existing = await query('SELECT id FROM admin_users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create admin user
    await query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role || 'admin']
    );

    await logAuditAction(req.user.id, 'create_admin', 'admin_users', null, req.ip);

    logger.info('New admin user created', { username, role: role || 'admin', by: req.user.username });

    res.status(201).json({ 
      message: 'Admin user created successfully',
      username,
      role: role || 'admin'
    });
  } catch (error) {
    logger.error('Failed to create admin user', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset admin password
router.post('/admin-reset-password', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { adminId, newPassword } = req.body;

    if (!adminId || !newPassword) {
      return res.status(400).json({ error: 'Admin ID and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Cannot reset your own password this way (use change-password instead)
    if (parseInt(adminId) === req.user.id) {
      return res.status(400).json({ error: 'Use /change-password to reset your own password' });
    }

    // Check if admin exists
    const admins = await query('SELECT id, username FROM admin_users WHERE id = ?', [adminId]);
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const targetAdmin = admins[0];

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await query(
      'UPDATE admin_users SET password_hash = ? WHERE id = ?',
      [hashedPassword, adminId]
    );

    await logAuditAction(req.user.id, 'reset_password', 'admin_users', adminId, req.ip);

    logger.info('Admin password reset', { targetAdmin: targetAdmin.username, by: req.user.username });

    res.json({ 
      message: 'Password reset successfully',
      username: targetAdmin.username
    });
  } catch (error) {
    logger.error('Failed to reset admin password', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update admin role
router.put('/admin-update-role', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { adminId, newRole } = req.body;

    if (!adminId || !newRole) {
      return res.status(400).json({ error: 'Admin ID and new role required' });
    }

    const validRoles = ['admin', 'viewer', 'super_admin'];
    if (!validRoles.includes(newRole)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, viewer, or super_admin' });
    }

    // Cannot change your own role
    if (parseInt(adminId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    // Check if admin exists
    const admins = await query('SELECT id, username, role FROM admin_users WHERE id = ?', [adminId]);
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const targetAdmin = admins[0];

    // Update role
    await query(
      'UPDATE admin_users SET role = ? WHERE id = ?',
      [newRole, adminId]
    );

    await logAuditAction(req.user.id, 'update_role', 'admin_users', adminId, req.ip);

    logger.info('Admin role updated', { 
      targetAdmin: targetAdmin.username, 
      oldRole: targetAdmin.role, 
      newRole,
      by: req.user.username 
    });

    res.json({ 
      message: 'Role updated successfully',
      username: targetAdmin.username,
      newRole
    });
  } catch (error) {
    logger.error('Failed to update admin role', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete admin user
router.post('/admin-delete', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.body;

    if (!adminId) {
      return res.status(400).json({ error: 'Admin ID required' });
    }

    // Cannot delete yourself
    if (parseInt(adminId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if admin exists
    const admins = await query('SELECT id, username, role FROM admin_users WHERE id = ?', [adminId]);
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const targetAdmin = admins[0];

    // Cannot delete super_admin
    if (targetAdmin.role === 'super_admin') {
      return res.status(403).json({ error: 'Cannot delete super_admin account' });
    }

    // Delete admin
    await query('DELETE FROM admin_users WHERE id = ?', [adminId]);

    await logAuditAction(req.user.id, 'delete_admin', 'admin_users', adminId, req.ip);

    logger.info('Admin user deleted', { targetAdmin: targetAdmin.username, by: req.user.username });

    res.json({ 
      message: 'Admin user deleted successfully',
      username: targetAdmin.username
    });
  } catch (error) {
    logger.error('Failed to delete admin user', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audit logging helper
async function logAuditAction(adminUserId, action, resource, resourceId, ipAddress) {
  try {
    await query(
      'INSERT INTO audit_logs (admin_user_id, action, resource, resource_id, ip_address) VALUES (?, ?, ?, ?, ?)',
      [adminUserId, action, resource, resourceId, ipAddress]
    );
  } catch (error) {
    logger.error('Failed to log audit action', { error: error.message });
  }
}

module.exports = router;
module.exports.authenticateToken = authenticateToken;
