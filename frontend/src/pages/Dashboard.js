import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Grid,
  Typography,
  Alert,
} from '@mui/material';
import {
  Email,
  People,
  Domain,
  GetApp,
} from '@mui/icons-material';
import { emailsAPI, usersAPI, domainsAPI, exportsAPI } from '../services/api';

function Dashboard() {
  const [stats, setStats] = useState({
    totalEmails: 0,
    totalUsers: 0,
    totalDomains: 0,
    totalExports: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Load stats in parallel
      const [emailStats, users, domains, exports] = await Promise.all([
        emailsAPI.getEmailStats(),
        usersAPI.getUsers({ limit: 1 }),
        domainsAPI.getDomains(),
        exportsAPI.getExports({ limit: 1 }),
      ]);

      setStats({
        totalEmails: emailStats.data.overview.total_emails || 0,
        totalUsers: users.data.pagination.total || 0,
        totalDomains: domains.data.domains.length || 0,
        totalExports: exports.data.pagination.total || 0,
      });
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      setError('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const StatCard = ({ title, value, icon, color }) => (
    <Card>
      <CardContent>
        <Box display="flex" alignItems="center">
          <Box color={color} mr={2}>
            {icon}
          </Box>
          <Box>
            <Typography color="textSecondary" gutterBottom>
              {title}
            </Typography>
            <Typography variant="h4" component="h2">
              {loading ? '...' : value.toLocaleString()}
            </Typography>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        Dashboard
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Total Emails"
            value={stats.totalEmails}
            icon={<Email fontSize="large" />}
            color="primary.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Active Users"
            value={stats.totalUsers}
            icon={<People fontSize="large" />}
            color="secondary.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Domains"
            value={stats.totalDomains}
            icon={<Domain fontSize="large" />}
            color="success.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="PST Exports"
            value={stats.totalExports}
            icon={<GetApp fontSize="large" />}
            color="warning.main"
          />
        </Grid>
      </Grid>

      <Box mt={4}>
        <Typography variant="h6" gutterBottom>
          System Status
        </Typography>
        <Alert severity="info">
          Google Workspace Email Backup system is running. Real-time IMAP monitoring and scheduled backups are active.
        </Alert>
      </Box>
    </Box>
  );
}

export default Dashboard;