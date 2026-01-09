const express = require('express');
const { query } = require('../services/database/databaseService');
const { authenticateToken } = require('./auth');
const winston = require('winston');

const router = express.Router();
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/domains.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// All routes require authentication
router.use(authenticateToken);

// Get all domains
router.get('/', async (req, res) => {
  try {
    const domains = await query(
      'SELECT d.*, COUNT(u.id) as user_count FROM domains d LEFT JOIN users u ON d.id = u.domain_id GROUP BY d.id ORDER BY d.created_at DESC'
    );

    res.json({ domains });
  } catch (error) {
    logger.error('Failed to get domains', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get domain by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const domains = await query('SELECT * FROM domains WHERE id = ?', [id]);
    if (domains.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    // Get users for this domain
    const users = await query(
      'SELECT id, email, status, last_uid, created_at FROM users WHERE domain_id = ? ORDER BY email',
      [id]
    );

    // Get email stats
    const stats = await query(
      'SELECT COUNT(*) as total_emails, SUM(size) as total_size FROM emails WHERE user_id IN (SELECT id FROM users WHERE domain_id = ?)',
      [id]
    );

    res.json({
      domain: domains[0],
      users,
      stats: stats[0],
    });
  } catch (error) {
    logger.error('Failed to get domain', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new domain
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Domain name required' });
    }

    // Validate domain name format
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!domainRegex.test(name)) {
      return res.status(400).json({ error: 'Invalid domain name format' });
    }

    // Check if domain already exists
    const existing = await query('SELECT id FROM domains WHERE name = ?', [name]);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Domain already exists' });
    }

    // Create domain
    const result = await query(
      'INSERT INTO domains (name) VALUES (?)',
      [name]
    );

    const domainId = result.insertId || result.lastID;

    // Log audit
    await logAuditAction(req.user.id, 'create_domain', 'domains', domainId, req.ip);

    logger.info('Domain created', { name, id: domainId, admin: req.user.username });

    res.status(201).json({
      domain: {
        id: domainId,
        name,
        created_at: new Date(),
      },
    });
  } catch (error) {
    logger.error('Failed to create domain', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update domain
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Domain name required' });
    }

    // Check if domain exists
    const domains = await query('SELECT * FROM domains WHERE id = ?', [id]);
    if (domains.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    // Check if new name conflicts
    const existing = await query('SELECT id FROM domains WHERE name = ? AND id != ?', [name, id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Domain name already exists' });
    }

    // Update domain
    await query(
      'UPDATE domains SET name = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [name, id]
    );

    // Log audit
    await logAuditAction(req.user.id, 'update_domain', 'domains', id, req.ip);

    logger.info('Domain updated', { id, name, admin: req.user.username });

    res.json({
      domain: {
        id,
        name,
        updated_at: new Date(),
      },
    });
  } catch (error) {
    logger.error('Failed to update domain', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete domain
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if domain exists and has users
    const domains = await query('SELECT * FROM domains WHERE id = ?', [id]);
    if (domains.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const userCount = await query('SELECT COUNT(*) as count FROM users WHERE domain_id = ?', [id]);
    if (userCount[0].count > 0) {
      return res.status(409).json({ error: 'Cannot delete domain with existing users' });
    }

    // Delete domain
    await query('DELETE FROM domains WHERE id = ?', [id]);

    // Log audit
    await logAuditAction(req.user.id, 'delete_domain', 'domains', id, req.ip);

    logger.info('Domain deleted', { id, name: domains[0].name, admin: req.user.username });

    res.json({ message: 'Domain deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete domain', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Discover users for domain (simulate user discovery)
router.post('/:id/discover-users', async (req, res) => {
  try {
    const { id } = req.params;
    const { userEmails } = req.body;

    if (!Array.isArray(userEmails)) {
      return res.status(400).json({ error: 'userEmails must be an array' });
    }

    // Check if domain exists
    const domains = await query('SELECT * FROM domains WHERE id = ?', [id]);
    if (domains.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const addedUsers = [];
    const skippedUsers = [];

    for (const email of userEmails) {
      // Validate email format and domain
      if (!email.includes('@') || !email.endsWith(`@${domains[0].name}`)) {
        skippedUsers.push({ email, reason: 'Invalid email or domain mismatch' });
        continue;
      }

      // Check if user already exists
      const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) {
        skippedUsers.push({ email, reason: 'User already exists' });
        continue;
      }

      // Add user
      const result = await query(
        'INSERT INTO users (domain_id, email) VALUES (?, ?)',
        [id, email]
      );

      const userId = result.insertId || result.lastID;
      addedUsers.push({ id: userId, email });
    }

    // Log audit
    await logAuditAction(req.user.id, 'discover_users', 'domains', id, req.ip);

    logger.info('Users discovered for domain', {
      domainId: id,
      added: addedUsers.length,
      skipped: skippedUsers.length,
      admin: req.user.username
    });

    res.json({
      added: addedUsers,
      skipped: skippedUsers,
    });
  } catch (error) {
    logger.error('Failed to discover users', { id: req.params.id, error: error.message });
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