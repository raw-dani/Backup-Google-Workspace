import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress,
  Grid,
  Paper,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  GetApp,
  Delete,
  Refresh,
  PlayArrow,
  Schedule,
  CheckCircle,
  Error,
  Pending,
} from '@mui/icons-material';
import { LinearProgress } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { exportsAPI, usersAPI } from '../services/api';

function Exports() {
  const [exports, setExports] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);

  // Create export dialog
  const [createDialog, setCreateDialog] = useState({
    open: false,
    loading: false,
  });

  const [newExport, setNewExport] = useState({
    userId: '',
    startDate: '',
    endDate: '',
    format: 'eml',
  });

  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    pages: 0,
  });

  const [filters, setFilters] = useState({
    status: '',
    userId: '',
  });

  useEffect(() => {
    loadUsers();
    loadExports();
    loadStats();

    // Poll for export status updates every 5 seconds
    const pollInterval = setInterval(() => {
      loadExports();
    }, 5000);

    return () => clearInterval(pollInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, pagination.page, pagination.limit]);

  const loadUsers = async () => {
    try {
      const response = await usersAPI.getUsers({ limit: 1000 });
      setUsers(response.data.users);
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  const loadExports = async () => {
    try {
      setLoading(true);
      const params = {
        page: pagination.page,
        limit: pagination.limit,
        ...filters,
      };

      // Remove empty filters
      Object.keys(params).forEach(key => {
        if (params[key] === '') delete params[key];
      });

      const response = await exportsAPI.getExports(params);
      setExports(response.data.exports);
      setPagination(response.data.pagination);
      setError('');
    } catch (error) {
      console.error('Failed to load exports:', error);
      setError('Failed to load exports');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await exportsAPI.getExportStats();
      setStats(response.data);
    } catch (error) {
      console.error('Failed to load export stats:', error);
    }
  };

  const handleCreateExport = async () => {
    try {
      setCreateDialog(prev => ({ ...prev, loading: true }));

      const exportData = {
        userId: newExport.userId,
        startDate: newExport.startDate || undefined,
        endDate: newExport.endDate || undefined,
        format: newExport.format,
      };

      console.log('🚀 Starting export creation...', exportData);

      const response = await exportsAPI.createExport(exportData, {
        timeout: 120000, // 120 seconds for large exports
      });

      console.log('✅ PST export created successfully:', response);

      setCreateDialog({ open: false, loading: false });
      setNewExport({ userId: '', startDate: '', endDate: '' });

      // Show success message with processing info
      const successMessage = response.data.estimatedEmails > 100
        ? `✅ PST export created! Processing ${response.data.estimatedEmails} emails may take ~${response.data.estimatedTimeMinutes} minutes. Monitor progress in the exports list.`
        : `✅ PST export created! Processing ${response.data.estimatedEmails} emails in the background.`;

      alert(successMessage);

      // Refresh the list
      await loadExports();
      await loadStats();
    } catch (error) {
      console.error('❌ Failed to create export:', error);

      let errorMessage = 'Failed to create export';
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Export creation timed out. The export may still be processing in the background. Please refresh the page to check the status.';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.message) {
        errorMessage = `Export creation failed: ${error.message}`;
      }

      setError(errorMessage);
      setCreateDialog(prev => ({ ...prev, loading: false }));

      // Don't close dialog on timeout, let user retry or cancel
      if (error.code !== 'ECONNABORTED') {
        alert(`❌ ${errorMessage}`);
      }
    }
  };

  const handleDownloadExport = async (exportItem) => {
    try {
      const response = await exportsAPI.downloadExport(exportItem.id);

      // Create download link
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', exportItem.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download export:', error);
      setError('Failed to download export');
    }
  };

  const handleRetryExport = async (exportItem) => {
    try {
      await exportsAPI.retryExport(exportItem.id);
      await loadExports();
      await loadStats();
    } catch (error) {
      console.error('Failed to retry export:', error);
      setError('Failed to retry export');
    }
  };

  const handleDeleteExport = async (exportItem) => {
    if (!window.confirm(`Are you sure you want to delete this export?\n\nFile: ${exportItem.filename}`)) {
      return;
    }

    try {
      await exportsAPI.deleteExport(exportItem.id);
      await loadExports();
      await loadStats();
    } catch (error) {
      console.error('Failed to delete export:', error);
      setError('Failed to delete export');
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed': return 'success';
      case 'processing': return 'info';
      case 'pending': return 'warning';
      case 'failed': return 'error';
      default: return 'default';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed': return <CheckCircle />;
      case 'processing': return <Schedule />;
      case 'pending': return <Pending />;
      case 'failed': return <Error />;
      default: return null;
    }
  };

  const columns = [
    {
      field: 'filename',
      headerName: 'Filename',
      flex: 2,
      renderCell: (params) => (
        <Typography variant="body2" noWrap title={params.value}>
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'user_email',
      headerName: 'User',
      flex: 1,
      renderCell: (params) => {
        const user = users.find(u => u.id === params.row.user_id);
        return (
          <Chip
            label={user?.email || 'Unknown'}
            size="small"
            variant="outlined"
          />
        );
      },
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: (params) => (
        <Chip
          icon={getStatusIcon(params.value)}
          label={params.value}
          size="small"
          color={getStatusColor(params.value)}
        />
      ),
    },
    {
      field: 'start_date',
      headerName: 'Start Date',
      width: 120,
      valueFormatter: (params) => params.value ? new Date(params.value).toLocaleDateString() : 'All',
    },
    {
      field: 'end_date',
      headerName: 'End Date',
      width: 120,
      valueFormatter: (params) => params.value ? new Date(params.value).toLocaleDateString() : 'All',
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 150,
      valueFormatter: (params) => new Date(params.value).toLocaleString(),
    },
    {
      field: 'completed_at',
      headerName: 'Completed',
      width: 150,
      valueFormatter: (params) => params.value ? new Date(params.value).toLocaleString() : '-',
    },
    {
      field: 'progress',
      headerName: 'Progress',
      width: 150,
      sortable: true,
      renderCell: (params) => {
        const progress = params.value || 0;
        const status = params.row.status;
        
        if (status === 'processing') {
          return (
            <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: '100%' }}>
                <LinearProgress 
                  variant="determinate" 
                  value={progress} 
                  sx={{ height: 8, borderRadius: 4 }}
                />
              </Box>
              <Typography variant="caption" sx={{ minWidth: 35 }}>
                {progress}%
              </Typography>
            </Box>
          );
        } else if (status === 'completed') {
          return (
            <Chip label="100%" color="success" size="small" variant="outlined" />
          );
        } else if (status === 'pending') {
          return (
            <Chip label="Queued" color="warning" size="small" variant="outlined" />
          );
        } else {
          return (
            <Chip label="-" size="small" variant="outlined" />
          );
        }
      },
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 200,
      sortable: false,
      renderCell: (params) => {
        const exportItem = params.row;

        return (
          <Box>
            {exportItem.status === 'completed' && (
              <Tooltip title="Download PST">
                <IconButton
                  size="small"
                  onClick={() => handleDownloadExport(exportItem)}
                  color="primary"
                >
                  <GetApp />
                </IconButton>
              </Tooltip>
            )}

            {exportItem.status === 'failed' && (
              <Tooltip title="Retry Export">
                <IconButton
                  size="small"
                  onClick={() => handleRetryExport(exportItem)}
                  color="warning"
                >
                  <PlayArrow />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Delete Export">
              <IconButton
                size="small"
                onClick={() => handleDeleteExport(exportItem)}
                color="error"
              >
                <Delete />
              </IconButton>
            </Tooltip>
          </Box>
        );
      },
    },
  ];

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" component="h1">
          PST Export Management
        </Typography>
        <Box>
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={() => {
              loadExports();
              loadStats();
            }}
            sx={{ mr: 1 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<GetApp />}
            onClick={() => setCreateDialog({ open: true, loading: false })}
          >
            Create Export
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Export Statistics */}
      {stats && (
        <Grid container spacing={3} mb={3}>
          <Grid item xs={12} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <GetApp color="primary" sx={{ fontSize: 40, mb: 1 }} />
              <Typography variant="h4">{stats.stats?.total_exports?.toLocaleString() || 0}</Typography>
              <Typography variant="body2" color="text.secondary">
                Total Exports
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <CheckCircle color="success" sx={{ fontSize: 40, mb: 1 }} />
              <Typography variant="h4">{stats.stats?.completed_exports?.toLocaleString() || 0}</Typography>
              <Typography variant="body2" color="text.secondary">
                Completed
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Schedule color="info" sx={{ fontSize: 40, mb: 1 }} />
              <Typography variant="h4">{stats.stats?.processing_exports?.toLocaleString() || 0}</Typography>
              <Typography variant="body2" color="text.secondary">
                Processing
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Error color="error" sx={{ fontSize: 40, mb: 1 }} />
              <Typography variant="h4">{stats.stats?.failed_exports?.toLocaleString() || 0}</Typography>
              <Typography variant="body2" color="text.secondary">
                Failed
              </Typography>
            </Paper>
          </Grid>
        </Grid>
      )}

      {/* Queue Status */}
      {stats?.queue && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Export Queue Status
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} md={3}>
                <Typography variant="body2" color="text.secondary">
                  Waiting: {stats.queue.waiting}
                </Typography>
              </Grid>
              <Grid item xs={12} md={3}>
                <Typography variant="body2" color="text.secondary">
                  Active: {stats.queue.active}
                </Typography>
              </Grid>
              <Grid item xs={12} md={3}>
                <Typography variant="body2" color="text.secondary">
                  Completed: {stats.queue.completed}
                </Typography>
              </Grid>
              <Grid item xs={12} md={3}>
                <Typography variant="body2" color="text.secondary">
                  Failed: {stats.queue.failed}
                </Typography>
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Filters
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth>
                <InputLabel>Status</InputLabel>
                <Select
                  value={filters.status}
                  onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
                  label="Status"
                >
                  <MenuItem value="">
                    <em>All Status</em>
                  </MenuItem>
                  <MenuItem value="pending">Pending</MenuItem>
                  <MenuItem value="processing">Processing</MenuItem>
                  <MenuItem value="completed">Completed</MenuItem>
                  <MenuItem value="failed">Failed</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth>
                <InputLabel>User</InputLabel>
                <Select
                  value={filters.userId}
                  onChange={(e) => setFilters(prev => ({ ...prev, userId: e.target.value }))}
                  label="User"
                >
                  <MenuItem value="">
                    <em>All Users</em>
                  </MenuItem>
                  {users.map((user) => (
                    <MenuItem key={user.id} value={user.id}>
                      {user.email}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => {
                  setFilters({ status: '', userId: '' });
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
              >
                Clear Filters
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Exports Table */}
      <Card>
        <CardContent>
          {loading ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : (
            <>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Typography variant="h6">
                  Exports ({pagination.total.toLocaleString()})
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Page {pagination.page} of {pagination.pages}
                </Typography>
              </Box>

              <DataGrid
                rows={exports}
                columns={columns}
                autoHeight
                disableRowSelectionOnClick
                loading={loading}
                pagination
                paginationMode="server"
                rowCount={pagination.total}
                paginationModel={{
                  page: pagination.page - 1,
                  pageSize: pagination.limit,
                }}
                onPaginationModelChange={(model) => {
                  const newPage = model.page + 1;
                  const newLimit = model.pageSize;
                  setPagination(prev => ({
                    ...prev,
                    page: newPage,
                    limit: newLimit,
                  }));
                }}
                pageSizeOptions={[10, 25, 50, 100]}
                hideFooterSelectedRowCount
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Export Dialog */}
      <Dialog
        open={createDialog.open}
        onClose={() => !createDialog.loading && setCreateDialog({ open: false, loading: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create New PST Export</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>User *</InputLabel>
              <Select
                value={newExport.userId}
                onChange={(e) => setNewExport(prev => ({ ...prev, userId: e.target.value }))}
                label="User *"
                required
              >
                {users.map((user) => (
                  <MenuItem key={user.id} value={user.id}>
                    {user.email}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              fullWidth
              label="Start Date"
              type="date"
              value={newExport.startDate}
              onChange={(e) => setNewExport(prev => ({ ...prev, startDate: e.target.value }))}
              InputLabelProps={{ shrink: true }}
              sx={{ mb: 2 }}
              helperText="Leave empty to export all emails from the beginning"
            />

            <TextField
              fullWidth
              label="End Date"
              type="date"
              value={newExport.endDate}
              onChange={(e) => setNewExport(prev => ({ ...prev, endDate: e.target.value }))}
              InputLabelProps={{ shrink: true }}
              sx={{ mb: 2 }}
              helperText="Leave empty to export all emails until now"
            />

            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Export Format</InputLabel>
              <Select
                value={newExport.format}
                onChange={(e) => setNewExport(prev => ({ ...prev, format: e.target.value }))}
                label="Export Format"
              >
                <MenuItem value="eml">
                  <Box>
                    <Typography variant="body1">EML (Recommended)</Typography>
                    <Typography variant="caption" color="text.secondary">
                      ZIP dengan EML files, compatible dengan Outlook & email clients lain
                    </Typography>
                  </Box>
                </MenuItem>
                <MenuItem value="pst">
                  <Box>
                    <Typography variant="body1">PST-Compatible</Typography>
                    <Typography variant="caption" color="text.secondary">
                      ZIP dengan EML + instruksi import untuk Microsoft Outlook
                    </Typography>
                  </Box>
                </MenuItem>
              </Select>
            </FormControl>

            <Alert severity="info" sx={{ mb: 2 }}>
              <Typography variant="body2">
                <strong>Format EML:</strong> File ZIP berisi EML files yang bisa diimport langsung ke Outlook, Thunderbird, dll.<br/>
                <strong>Format PST:</strong> Sama dengan EML, plus instruksi import lengkap untuk Microsoft Outlook.
              </Typography>
            </Alert>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setCreateDialog({ open: false, loading: false })}
            disabled={createDialog.loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateExport}
            variant="contained"
            disabled={createDialog.loading || !newExport.userId}
            startIcon={createDialog.loading ? <CircularProgress size={20} /> : null}
          >
            {createDialog.loading ? 'Creating...' : 'Create Export'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Exports;
