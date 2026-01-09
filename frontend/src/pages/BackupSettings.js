import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Grid,
  Alert,
  Divider,
  CircularProgress,
  Card,
  CardContent,
  Chip
} from '@mui/material';
import {
  Settings as SettingsIcon,
  PlayArrow as PlayIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon
} from '@mui/icons-material';
import api from '../services/api';

const BackupSettings = () => {
  const [config, setConfig] = useState({
    backupInterval: '60',
    maxConcurrentUsers: '3',
    batchSize: '5',
    batchDelay: '2000',
    useRealGmail: false
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError('');

      // Try authenticated endpoint first
      try {
        const response = await api.get('/backup/config');
        setConfig(response.data.config);
        return;
      } catch (authError) {
        // If auth fails, try debug endpoint
        const response = await api.get('/debug/backup/config-debug');
        setConfig(response.data.config);
      }
    } catch (err) {
      setError(`Failed to load backup configuration: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setMessage('');
      setError('');
      setSaving(true);

      const response = await api.put('/backup/config', {
        backupInterval: parseInt(config.backupInterval),
        maxConcurrentUsers: parseInt(config.maxConcurrentUsers),
        batchSize: parseInt(config.batchSize),
        batchDelay: parseInt(config.batchDelay)
      });

      setConfig(response.data.config);
      setMessage('Backup configuration updated successfully');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleManualBackup = async () => {
    try {
      setMessage('');
      setError('');

      await api.post('/backup/manual');
      setMessage('Manual backup started in background');
    } catch (err) {
      setError('Failed to start manual backup');
    }
  };

  const handleChange = (field) => (event) => {
    const value = field === 'useRealGmail' ? event.target.checked : event.target.value;
    setConfig({ ...config, [field]: value });
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom fontWeight="bold">
        Backup Settings
      </Typography>

      {message && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage('')}>
          {message}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Main Settings Card */}
        <Grid item xs={12} md={8}>
          <Paper elevation={2} sx={{ p: 3 }}>
            <Box display="flex" alignItems="center" mb={3}>
              <SettingsIcon color="primary" sx={{ mr: 1 }} />
              <Typography variant="h6">Backup Configuration</Typography>
            </Box>

            <Grid container spacing={3}>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Backup Interval</InputLabel>
                  <Select
                    value={config.backupInterval}
                    onChange={handleChange('backupInterval')}
                    label="Backup Interval"
                  >
                    <MenuItem value="5">Every 5 minutes</MenuItem>
                    <MenuItem value="15">Every 15 minutes</MenuItem>
                    <MenuItem value="30">Every 30 minutes</MenuItem>
                    <MenuItem value="60">Every hour</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} sm={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Max Concurrent Users</InputLabel>
                  <Select
                    value={config.maxConcurrentUsers}
                    onChange={handleChange('maxConcurrentUsers')}
                    label="Max Concurrent Users"
                  >
                    <MenuItem value="1">1 User</MenuItem>
                    <MenuItem value="2">2 Users</MenuItem>
                    <MenuItem value="3">3 Users</MenuItem>
                    <MenuItem value="5">5 Users</MenuItem>
                    <MenuItem value="10">10 Users</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} sm={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Batch Size</InputLabel>
                  <Select
                    value={config.batchSize}
                    onChange={handleChange('batchSize')}
                    label="Batch Size"
                  >
                    <MenuItem value="1">1 Email</MenuItem>
                    <MenuItem value="5">5 Emails</MenuItem>
                    <MenuItem value="10">10 Emails</MenuItem>
                    <MenuItem value="20">20 Emails</MenuItem>
                    <MenuItem value="50">50 Emails</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} sm={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Batch Delay</InputLabel>
                  <Select
                    value={config.batchDelay}
                    onChange={handleChange('batchDelay')}
                    label="Batch Delay"
                  >
                    <MenuItem value="500">500ms</MenuItem>
                    <MenuItem value="1000">1 second</MenuItem>
                    <MenuItem value="2000">2 seconds</MenuItem>
                    <MenuItem value="5000">5 seconds</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
            </Grid>

            <Divider sx={{ my: 3 }} />

            <Box display="flex" gap={2}>
              <Button
                variant="contained"
                startIcon={<SaveIcon />}
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </Button>
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={loadConfig}
              >
                Reset
              </Button>
            </Box>
          </Paper>
        </Grid>

        {/* Current Configuration Card */}
        <Grid item xs={12} md={4}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Current Configuration
              </Typography>
              <Box sx={{ mt: 2 }}>
                <Box display="flex" justifyContent="space-between" py={1}>
                  <Typography color="textSecondary">Interval</Typography>
                  <Typography fontWeight="medium">{config.backupInterval} minutes</Typography>
                </Box>
                <Divider />
                <Box display="flex" justifyContent="space-between" py={1}>
                  <Typography color="textSecondary">Concurrent Users</Typography>
                  <Typography fontWeight="medium">{config.maxConcurrentUsers}</Typography>
                </Box>
                <Divider />
                <Box display="flex" justifyContent="space-between" py={1}>
                  <Typography color="textSecondary">Batch Size</Typography>
                  <Typography fontWeight="medium">{config.batchSize} emails</Typography>
                </Box>
                <Divider />
                <Box display="flex" justifyContent="space-between" py={1}>
                  <Typography color="textSecondary">Batch Delay</Typography>
                  <Typography fontWeight="medium">{config.batchDelay}ms</Typography>
                </Box>
                <Divider />
                <Box display="flex" justifyContent="space-between" py={1}>
                  <Typography color="textSecondary">Gmail Mode</Typography>
                  <Chip
                    label={config.useRealGmail ? 'Real' : 'Simulated'}
                    color={config.useRealGmail ? 'success' : 'default'}
                    size="small"
                  />
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Manual Backup Card */}
        <Grid item xs={12}>
          <Paper elevation={2} sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Manual Backup
            </Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Start a manual backup for all connected email accounts. This will run in the background.
            </Typography>
            <Button
              variant="contained"
              color="secondary"
              startIcon={<PlayIcon />}
              onClick={handleManualBackup}
            >
              Run Manual Backup Now
            </Button>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default BackupSettings;
