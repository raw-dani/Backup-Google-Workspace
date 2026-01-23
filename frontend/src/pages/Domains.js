import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  Chip,
  IconButton,
  Tooltip,
  Grid,
  Paper,
  CircularProgress,
} from '@mui/material';
import {
  Add,
  Edit,
  Delete,
  Search,
  People,
  Email,
  Storage,
  Refresh,
} from '@mui/icons-material';
import { DataGrid } from '@mui/x-data-grid';
import { domainsAPI } from '../services/api';

function Domains() {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [domainDialog, setDomainDialog] = useState({
    open: false,
    mode: 'add', // 'add' or 'edit'
    data: { name: '' },
  });
  const [discoverDialog, setDiscoverDialog] = useState({
    open: false,
    domain: null,
    userEmails: '',
    loading: false,
    result: null,
  });

  useEffect(() => {
    loadDomains();
  }, []);

  const loadDomains = async () => {
    try {
      setLoading(true);
      const response = await domainsAPI.getDomains();
      setDomains(response.data.domains);
      setError('');
    } catch (error) {
      console.error('Failed to load domains:', error);
      setError('Failed to load domains');
    } finally {
      setLoading(false);
    }
  };

  const handleAddDomain = () => {
    setDomainDialog({
      open: true,
      mode: 'add',
      data: { name: '' },
    });
  };

  const handleEditDomain = (domain) => {
    setDomainDialog({
      open: true,
      mode: 'edit',
      data: { ...domain },
    });
  };

  const handleDeleteDomain = async (domain) => {
    if (!window.confirm(`Are you sure you want to delete domain "${domain.name}"? This will also delete all associated users.`)) {
      return;
    }

    try {
      await domainsAPI.deleteDomain(domain.id);
      await loadDomains();
    } catch (error) {
      console.error('Failed to delete domain:', error);
      setError('Failed to delete domain');
    }
  };

  const handleSaveDomain = async () => {
    try {
      const { mode, data } = domainDialog;

      if (mode === 'add') {
        await domainsAPI.createDomain(data);
      } else {
        await domainsAPI.updateDomain(data.id, data);
      }

      setDomainDialog({ open: false, mode: 'add', data: { name: '' } });
      await loadDomains();
    } catch (error) {
      console.error('Failed to save domain:', error);
      setError('Failed to save domain');
    }
  };

  const handleDiscoverUsers = (domain) => {
    setDiscoverDialog({
      open: true,
      domain,
      userEmails: '',
      loading: false,
      result: null,
    });
  };

  const handleDiscoverUsersSubmit = async () => {
    try {
      setDiscoverDialog(prev => ({ ...prev, loading: true, result: null }));

      const emails = discoverDialog.userEmails
        .split('\n')
        .map(email => email.trim())
        .filter(email => email.length > 0);

      const response = await domainsAPI.discoverUsers(discoverDialog.domain.id, { userEmails: emails });

      setDiscoverDialog(prev => ({
        ...prev,
        loading: false,
        result: response.data,
      }));

      // Reload domains to update user counts
      await loadDomains();
    } catch (error) {
      console.error('Failed to discover users:', error);
      setDiscoverDialog(prev => ({
        ...prev,
        loading: false,
        result: { error: 'Failed to discover users' },
      }));
    }
  };

  const columns = [
    {
      field: 'name',
      headerName: 'Domain Name',
      flex: 1,
      renderCell: (params) => (
        <Typography variant="body2" fontWeight="medium">
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'user_count',
      headerName: 'Users',
      width: 100,
      align: 'center',
      renderCell: (params) => (
        <Chip
          icon={<People />}
          label={params.value || 0}
          size="small"
          color={params.value > 0 ? 'primary' : 'default'}
        />
      ),
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 150,
      valueFormatter: (params) => new Date(params.value).toLocaleDateString(),
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 200,
      sortable: false,
      renderCell: (params) => (
        <Box>
          <Tooltip title="Discover Users">
            <IconButton
              size="small"
              onClick={() => handleDiscoverUsers(params.row)}
              color="info"
            >
              <Search />
            </IconButton>
          </Tooltip>
          <Tooltip title="Edit Domain">
            <IconButton
              size="small"
              onClick={() => handleEditDomain(params.row)}
              color="primary"
            >
              <Edit />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete Domain">
            <IconButton
              size="small"
              onClick={() => handleDeleteDomain(params.row)}
              color="error"
            >
              <Delete />
            </IconButton>
          </Tooltip>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h4" component="h1" gutterBottom>
          Domains Management
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Add multiple domains to backup users from different Google Workspace organizations
        </Typography>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={loadDomains}
            sx={{ mr: 2 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={handleAddDomain}
          >
            Add Domain
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Card>
        <CardContent>
          {loading ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : (
            <DataGrid
              rows={domains}
              columns={columns}
              pageSize={10}
              rowsPerPageOptions={[10, 25, 50]}
              autoHeight
              disableSelectionOnClick
              onRowClick={(params) => setSelectedDomain(params.row)}
            />
          )}
        </CardContent>
      </Card>

      {/* Domain Details */}
      {selectedDomain && (
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Domain Details: {selectedDomain.name}
            </Typography>
            <Grid container spacing={3}>
              <Grid item xs={12} md={4}>
                <Paper sx={{ p: 2, textAlign: 'center' }}>
                  <People color="primary" sx={{ fontSize: 40, mb: 1 }} />
                  <Typography variant="h4">{selectedDomain.user_count || 0}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Active Users
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} md={4}>
                <Paper sx={{ p: 2, textAlign: 'center' }}>
                  <Email color="secondary" sx={{ fontSize: 40, mb: 1 }} />
                  <Typography variant="h4">{selectedDomain.total_emails || 0}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Total Emails
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} md={4}>
                <Paper sx={{ p: 2, textAlign: 'center' }}>
                  <Storage color="success" sx={{ fontSize: 40, mb: 1 }} />
                  <Typography variant="h4">{selectedDomain.total_size ? (selectedDomain.total_size / 1024 / 1024).toFixed(1) : 0} MB</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Storage Used
                  </Typography>
                </Paper>
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}

      {/* Add/Edit Domain Dialog */}
      <Dialog
        open={domainDialog.open}
        onClose={() => setDomainDialog({ open: false, mode: 'add', data: { name: '' } })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {domainDialog.mode === 'add' ? 'Add New Domain' : 'Edit Domain'}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Domain Name"
            fullWidth
            variant="outlined"
            value={domainDialog.data.name}
            onChange={(e) => setDomainDialog(prev => ({
              ...prev,
              data: { ...prev.data, name: e.target.value }
            }))}
            placeholder="example.com"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDomainDialog({ open: false, mode: 'add', data: { name: '' } })}>
            Cancel
          </Button>
          <Button onClick={handleSaveDomain} variant="contained">
            {domainDialog.mode === 'add' ? 'Add Domain' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Discover Users Dialog */}
      <Dialog
        open={discoverDialog.open}
        onClose={() => setDiscoverDialog({ open: false, domain: null, userEmails: '', loading: false, result: null })}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          Discover Users for {discoverDialog.domain?.name}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Enter email addresses (one per line) to add users to this domain:
          </Typography>
          <TextField
            multiline
            rows={6}
            fullWidth
            variant="outlined"
            placeholder="user1@example.com&#10;user2@example.com&#10;user3@example.com"
            value={discoverDialog.userEmails}
            onChange={(e) => setDiscoverDialog(prev => ({ ...prev, userEmails: e.target.value }))}
            disabled={discoverDialog.loading}
          />

          {discoverDialog.result && (
            <Box mt={2}>
              <Typography variant="h6" gutterBottom>
                Results:
              </Typography>
              {discoverDialog.result.error ? (
                <Alert severity="error">{discoverDialog.result.error}</Alert>
              ) : (
                <Box>
                  <Alert severity="success" sx={{ mb: 1 }}>
                    Added: {discoverDialog.result.added?.length || 0} users
                  </Alert>
                  {discoverDialog.result.skipped?.length > 0 && (
                    <Alert severity="warning">
                      Skipped: {discoverDialog.result.skipped?.length || 0} users
                      {discoverDialog.result.skipped.map((item, index) => (
                        <div key={index}>• {item.email}: {item.reason}</div>
                      ))}
                    </Alert>
                  )}
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDiscoverDialog({ open: false, domain: null, userEmails: '', loading: false, result: null })}
          >
            Close
          </Button>
          <Button
            onClick={handleDiscoverUsersSubmit}
            variant="contained"
            disabled={discoverDialog.loading || !discoverDialog.userEmails.trim()}
          >
            {discoverDialog.loading ? <CircularProgress size={20} /> : 'Discover Users'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Domains;
