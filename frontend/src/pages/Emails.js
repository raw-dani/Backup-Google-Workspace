import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  TextField,
  Button,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Paper,
  Divider,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  Search,
  Clear,
  Download,
  Delete,
  Email,
  Person,
  Schedule,
  Storage,
  ExpandMore,
  Refresh,
  DeleteSweep,
  Visibility,
  AttachFile,
  RemoveRedEye,
} from '@mui/icons-material';
import { DataGrid } from '@mui/x-data-grid';
import { emailsAPI, usersAPI } from '../services/api';

function Emails() {
  const [searchParams, setSearchParams] = useState({
    q: '',
    subject: '',
    from: '',
    to: '',
    user_id: '',
    folder: '',
    date_from: null,
    date_to: null,
  });
  const [searchResults, setSearchResults] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    pages: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [selectedEmails, setSelectedEmails] = useState([]);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);

  // Email detail dialog (raw view)
  const [emailDialog, setEmailDialog] = useState({
    open: false,
    email: null,
    preview: null,
    loading: false,
  });

  // Readable email viewer dialog
  const [readableEmailDialog, setReadableEmailDialog] = useState({
    open: false,
    email: null,
    fullEmail: null,
    attachments: [],
    loading: false,
  });



  useEffect(() => {
    loadUsers();
    loadEmailStats();
  }, []);

  const loadUsers = async () => {
    try {
      const response = await usersAPI.getUsers({ limit: 1000 });
      setUsers(response.data.users);
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  const loadEmailStats = async () => {
    try {
      setStatsLoading(true);
      const response = await emailsAPI.getEmailStats();
      setStats(response.data);
    } catch (error) {
      console.error('Failed to load email stats:', error);
      // Set default empty stats to avoid UI breaking
      setStats({
        overview: {
          total_emails: 0,
          total_size: 0,
          active_users: 0,
          avg_size: 0
        },
        users: [],
        domains: [],
        daily: [],
        period: 30
      });
    } finally {
      setStatsLoading(false);
    }
  };

  const handleSearch = async (page = 1) => {
    try {
      setLoading(true);
      setError('');

      // Build params with current search values
      const params = {
        q: searchParams.q || undefined,
        subject: searchParams.subject || undefined,
        from: searchParams.from || undefined,
        to: searchParams.to || undefined,
        user_id: searchParams.user_id || undefined,
        folder: searchParams.folder || undefined,
        // Only add date params if they have valid string values
        ...(searchParams.date_from && { date_from: searchParams.date_from }),
        ...(searchParams.date_to && { date_to: searchParams.date_to }),
        page,
        limit: pagination.limit,
      };

      // Remove any remaining undefined/empty parameters
      Object.keys(params).forEach(key => {
        if (params[key] === '' || params[key] === null || params[key] === undefined) {
          delete params[key];
        }
      });

      console.log('Searching emails with params:', params);
      const response = await emailsAPI.searchEmails(params);
      
      // Update search results and pagination
      setSearchResults(response.data.emails || []);
      setPagination(prev => ({
        ...prev,
        page: response.data.pagination?.page || page,
        total: response.data.pagination?.total || 0,
        pages: response.data.pagination?.pages || 0,
      }));
      
      // Clear selection when search results change
      setSelectedEmails([]);
    } catch (error) {
      console.error('Search failed:', error);
      setError('Search failed. Please try again.');
      setSearchResults([]);
      setPagination(prev => ({ ...prev, total: 0, pages: 0 }));
    } finally {
      setLoading(false);
    }
  };

  // Search with explicit limit (for page size changes)
  const handleSearchWithLimit = async (page = 1, customLimit = pagination.limit) => {
    try {
      setLoading(true);
      setError('');

      // Build params with current search values
      const params = {
        q: searchParams.q || undefined,
        subject: searchParams.subject || undefined,
        from: searchParams.from || undefined,
        to: searchParams.to || undefined,
        user_id: searchParams.user_id || undefined,
        folder: searchParams.folder || undefined,
        ...(searchParams.date_from && { date_from: searchParams.date_from }),
        ...(searchParams.date_to && { date_to: searchParams.date_to }),
        page,
        limit: customLimit,
      };

      // Remove any remaining undefined/empty parameters
      Object.keys(params).forEach(key => {
        if (params[key] === '' || params[key] === null || params[key] === undefined) {
          delete params[key];
        }
      });

      console.log('Searching with custom limit:', params);
      const response = await emailsAPI.searchEmails(params);
      
      // Update search results and pagination
      setSearchResults(response.data.emails || []);
      setPagination(prev => ({
        ...prev,
        page: response.data.pagination?.page || page,
        total: response.data.pagination?.total || 0,
        pages: response.data.pagination?.pages || 0,
        limit: customLimit,
      }));
      
      // Clear selection when search results change
      setSelectedEmails([]);
    } catch (error) {
      console.error('Search failed:', error);
      setError('Search failed. Please try again.');
      setSearchResults([]);
      setPagination(prev => ({ ...prev, total: 0, pages: 0 }));
    } finally {
      setLoading(false);
    }
  };

  const handleClearSearch = () => {
    setSearchParams({
      q: '',
      subject: '',
      from: '',
      to: '',
      user_id: '',
      folder: '',
      date_from: null,
      date_to: null,
    });
    setSearchResults([]);
    setPagination({ page: 1, limit: 25, total: 0, pages: 0 });
  };

  const handleViewEmail = async (email) => {
    try {
      setEmailDialog({ open: true, email, preview: null, loading: true });

      const response = await emailsAPI.getEmailPreview(email.id);
      setEmailDialog(prev => ({
        ...prev,
        preview: response.data,
        loading: false,
      }));
    } catch (error) {
      console.error('Failed to load email preview:', error);
      setEmailDialog(prev => ({
        ...prev,
        loading: false,
      }));
    }
  };

  const handleViewReadableEmail = async (email) => {
    try {
      setReadableEmailDialog({ open: true, email, fullEmail: null, attachments: [], loading: true });

      // Get full email details including attachments
      const [emailResponse, attachmentsResponse] = await Promise.all([
        emailsAPI.getEmailById(email.id),
        emailsAPI.getEmailAttachments(email.id)
      ]);

      setReadableEmailDialog(prev => ({
        ...prev,
        fullEmail: emailResponse.data.email,
        attachments: attachmentsResponse.data.attachments || [],
        loading: false,
      }));
    } catch (error) {
      console.error('Failed to load readable email:', error);
      setReadableEmailDialog(prev => ({
        ...prev,
        loading: false,
      }));
    }
  };

  const handleDownloadEmail = async (email) => {
    try {
      const response = await emailsAPI.getEmailContent(email.id);
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${email.message_id || 'email'}.eml`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download email:', error);
      setError('Failed to download email');
    }
  };

  const handleDeleteEmail = async (email) => {
    if (!window.confirm(`Are you sure you want to delete this email?\n\nSubject: ${email.subject}\nFrom: ${email.from_email}`)) {
      return;
    }

    try {
      await emailsAPI.deleteEmail(email.id);
      // Refresh search results
      handleSearch(pagination.page);
      loadEmailStats();
    } catch (error) {
      console.error('Failed to delete email:', error);
      setError('Failed to delete email');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedEmails.length === 0) {
      setError('No emails selected for deletion');
      return;
    }

    const confirmMessage = `Are you sure you want to delete ${selectedEmails.length} selected email(s)?\n\nThis action cannot be undone.`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setBulkDeleteLoading(true);
      setError('');

      const response = await emailsAPI.bulkDeleteEmails(selectedEmails);

      // Show results
      const { deleted, failed } = response.data.results;
      if (failed > 0) {
        setError(`Bulk delete completed: ${deleted} deleted, ${failed} failed`);
      } else {
        alert(`✅ Successfully deleted ${deleted} email(s)`);
      }

      // Clear selection and refresh
      setSelectedEmails([]);
      handleSearch(pagination.page);
      loadEmailStats();
    } catch (error) {
      console.error('Failed to bulk delete emails:', error);
      setError('Failed to delete selected emails');
    } finally {
      setBulkDeleteLoading(false);
    }
  };

  const handleViewAttachment = async (emailId, attachment) => {
    try {
      // Get attachment as blob for browser viewing
      const response = await emailsAPI.downloadAttachment(emailId, attachment.id);
      const mimeType = attachment.mime_type || 'application/octet-stream';
      const blob = new Blob([response.data], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      // Open in new browser tab/window - let browser handle viewing
      window.open(blobUrl, '_blank');

      // Clean up blob URL after a delay to allow browser to load
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 1000);

    } catch (error) {
      console.error('Failed to view attachment:', error);
      setError('Failed to view attachment');
    }
  };



  const handleDownloadAttachment = async (emailId, attachment) => {
    try {
      const response = await emailsAPI.downloadAttachment(emailId, attachment.id);
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', attachment.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download attachment:', error);
      setError('Failed to download attachment');
    }
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      const allIds = searchResults.map(email => email.id);
      setSelectedEmails(allIds);
    } else {
      setSelectedEmails([]);
    }
  };

  const isAllSelected = searchResults.length > 0 && selectedEmails.length === searchResults.length;
  const isIndeterminate = selectedEmails.length > 0 && selectedEmails.length < searchResults.length;

  // Helper function to format bytes
  const formatBytes = (bytes) => {
    // Handle null, undefined, or non-numeric values
    if (bytes === null || bytes === undefined || isNaN(bytes)) {
      return '0 B';
    }
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    const safeIndex = Math.max(0, Math.min(i, sizes.length - 1));
    return parseFloat((bytes / Math.pow(k, safeIndex)).toFixed(1)) + ' ' + sizes[safeIndex];
  };

  const columns = [
    {
      field: 'select',
      headerName: '',
      width: 50,
      sortable: false,
      renderHeader: () => (
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(el) => {
            if (el) el.indeterminate = isIndeterminate;
          }}
          onChange={(e) => handleSelectAll(e.target.checked)}
          title={isAllSelected ? 'Deselect all' : 'Select all'}
        />
      ),
      renderCell: (params) => (
        <input
          type="checkbox"
          checked={selectedEmails.includes(params.row.id)}
          onChange={(e) => {
            if (e.target.checked) {
              setSelectedEmails(prev => [...prev, params.row.id]);
            } else {
              setSelectedEmails(prev => prev.filter(id => id !== params.row.id));
            }
          }}
        />
      ),
    },
    {
      field: 'subject',
      headerName: 'Subject',
      flex: 2,
      renderCell: (params) => (
        <Typography variant="body2" noWrap title={params.value}>
          {params.value || '(No Subject)'}
        </Typography>
      ),
    },
    {
      field: 'from_email',
      headerName: 'From',
      flex: 1,
      renderCell: (params) => (
        <Typography variant="body2" noWrap title={params.value}>
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'to_email',
      headerName: 'To',
      flex: 1,
      renderCell: (params) => (
        <Typography variant="body2" noWrap title={params.value}>
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'date',
      headerName: 'Date',
      width: 150,
      valueFormatter: (params) => new Date(params.value).toLocaleString(),
    },
    {
      field: 'size',
      headerName: 'Size',
      width: 100,
      align: 'right',
      valueFormatter: (params) => {
        const size = params.value || 0;
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
      },
    },
    {
      field: 'user_email',
      headerName: 'User',
      width: 150,
      renderCell: (params) => (
        <Chip
          label={params.value}
          size="small"
          variant="outlined"
        />
      ),
    },
    {
      field: 'folder',
      headerName: 'Folder',
      width: 100,
      renderCell: (params) => {
        const folder = params.value || 'INBOX';
        const getFolderColor = (f) => {
          switch (f.toUpperCase()) {
            case 'INBOX': return 'primary';
            case 'SENT': return 'success';
            case 'DRAFT': return 'warning';
            case 'SPAM': return 'error';
            case 'TRASH': return 'default';
            case 'STARRED': return 'secondary';
            case 'IMPORTANT': return 'info';
            default: return 'default';
          }
        };
        return (
          <Chip
            label={folder}
            size="small"
            color={getFolderColor(folder)}
            variant="outlined"
          />
        );
      },
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 150,
      sortable: false,
      renderCell: (params) => (
        <Box>
          <Tooltip title="View Readable Email">
            <IconButton
              size="small"
              onClick={() => handleViewReadableEmail(params.row)}
              color="primary"
            >
              <Visibility />
            </IconButton>
          </Tooltip>
          <Tooltip title="View Raw Email">
            <IconButton
              size="small"
              onClick={() => handleViewEmail(params.row)}
              color="info"
            >
              <Email />
            </IconButton>
          </Tooltip>
          <Tooltip title="Download EML">
            <IconButton
              size="small"
              onClick={() => handleDownloadEmail(params.row)}
              color="secondary"
            >
              <Download />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete Email">
            <IconButton
              size="small"
              onClick={() => handleDeleteEmail(params.row)}
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
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h4" component="h1">
            Email Search & Management
          </Typography>
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={() => {
              loadEmailStats();
              if (searchResults.length > 0) {
                handleSearch(pagination.page);
              }
            }}
          >
            Refresh
          </Button>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Email Statistics */}
        {statsLoading ? (
          <Grid container spacing={3} mb={3}>
            {[1, 2, 3, 4].map((i) => (
              <Grid item xs={12} md={3} key={i}>
                <Paper sx={{ p: 2, textAlign: 'center' }}>
                  <CircularProgress size={24} sx={{ mb: 1 }} />
                  <Typography variant="body2" color="text.secondary">
                    Loading statistics...
                  </Typography>
                </Paper>
              </Grid>
            ))}
          </Grid>
        ) : (
          <Grid container spacing={3} mb={3}>
            {/* Overview Stats */}
            <Grid item xs={12} md={3}>
              <Paper sx={{ p: 2, textAlign: 'center' }}>
                <Email color="primary" sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="h4">
                  {stats?.overview?.total_emails?.toLocaleString() || 0}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Total Emails
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  All time
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={3}>
              <Paper sx={{ p: 2, textAlign: 'center' }}>
                <Person color="secondary" sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="h4">
                  {stats?.overview?.active_users?.toLocaleString() || 0}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Active Users
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  With emails
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={3}>
              <Paper sx={{ p: 2, textAlign: 'center' }}>
                <Storage color="success" sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="h4">
                  {formatBytes(stats?.overview?.total_size || 0)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Total Storage
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Email data size
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={3}>
              <Paper sx={{ p: 2, textAlign: 'center' }}>
                <Schedule color="warning" sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="h4">
                  {formatBytes(stats?.overview?.avg_size || 0)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Avg Email Size
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Per message
                </Typography>
              </Paper>
            </Grid>

            {/* User Statistics */}
            {stats?.users && stats.users.length > 0 && (
              <Grid item xs={12} md={6}>
                <Paper sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Top Email Users
                  </Typography>
                  {stats.users.slice(0, 5).map((user, index) => (
                    <Box key={user.user_email} sx={{ mb: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Typography variant="body2" sx={{ fontWeight: index < 3 ? 'bold' : 'normal' }}>
                          {user.user_email}
                        </Typography>
                        <Chip
                          label={`${user.email_count} emails`}
                          size="small"
                          color={index === 0 ? 'primary' : index === 1 ? 'secondary' : 'default'}
                        />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        {user.total_size ? (user.total_size / (1024 * 1024)).toFixed(1) : 0} MB • Last: {user.latest_email ? new Date(user.latest_email).toLocaleDateString() : 'Never'}
                      </Typography>
                    </Box>
                  ))}
                </Paper>
              </Grid>
            )}

            {/* Domain Statistics */}
            {stats.domains && stats.domains.length > 0 && (
              <Grid item xs={12} md={6}>
                <Paper sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Domain Breakdown
                  </Typography>
                  {stats.domains.map((domain, index) => (
                    <Box key={domain.domain} sx={{ mb: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Typography variant="body2">
                          {domain.domain || 'Unknown'}
                        </Typography>
                        <Chip
                          label={`${domain.email_count} emails`}
                          size="small"
                          variant="outlined"
                        />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        {domain.total_size ? (domain.total_size / (1024 * 1024)).toFixed(1) : 0} MB total
                      </Typography>
                    </Box>
                  ))}
                </Paper>
              </Grid>
            )}

            {/* Daily Activity Chart (Simple) */}
            {stats.daily && stats.daily.length > 0 && (
              <Grid item xs={12}>
                <Paper sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Daily Email Activity (Last 7 Days)
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {stats.daily.map((day, index) => (
                      <Box key={day.date} sx={{ textAlign: 'center', minWidth: 80 }}>
                        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                          {day.email_count}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          {new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Paper>
              </Grid>
            )}
          </Grid>
        )}

        {/* Search Form */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Search Emails
            </Typography>

            <Accordion expanded={true} onChange={() => {}}>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography>Advanced Search Filters</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <TextField
                      fullWidth
                      label="General Search"
                      placeholder="Search in subject, from, to..."
                      value={searchParams.q}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, q: e.target.value }))}
                    />
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <TextField
                      fullWidth
                      label="Subject"
                      value={searchParams.subject}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, subject: e.target.value }))}
                    />
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <TextField
                      fullWidth
                      label="From Email"
                      value={searchParams.from}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, from: e.target.value }))}
                    />
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <TextField
                      fullWidth
                      label="To Email"
                      value={searchParams.to}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, to: e.target.value }))}
                    />
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <FormControl fullWidth>
                      <InputLabel>User</InputLabel>
                      <Select
                        value={searchParams.user_id}
                        onChange={(e) => setSearchParams(prev => ({ ...prev, user_id: e.target.value }))}
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
                    <FormControl fullWidth>
                      <InputLabel>Folder</InputLabel>
                      <Select
                        value={searchParams.folder}
                        onChange={(e) => setSearchParams(prev => ({ ...prev, folder: e.target.value }))}
                        label="Folder"
                      >
                        <MenuItem value="">
                          <em>All Folders</em>
                        </MenuItem>
                        <MenuItem value="INBOX">Inbox</MenuItem>
                        <MenuItem value="SENT">Sent</MenuItem>
                        <MenuItem value="DRAFT">Drafts</MenuItem>
                        <MenuItem value="SPAM">Spam</MenuItem>
                        <MenuItem value="TRASH">Trash</MenuItem>
                        <MenuItem value="STARRED">Starred</MenuItem>
                        <MenuItem value="IMPORTANT">Important</MenuItem>
                        <MenuItem value="UNREAD">Unread</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <TextField
                      fullWidth
                      label="Date From"
                      type="date"
                      value={searchParams.date_from || ''}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, date_from: e.target.value }))}
                      InputLabelProps={{ shrink: true }}
                    />
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <TextField
                      fullWidth
                      label="Date To"
                      type="date"
                      value={searchParams.date_to || ''}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, date_to: e.target.value }))}
                      InputLabelProps={{ shrink: true }}
                    />
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <Box display="flex" gap={1}>
                      <Button
                        variant="contained"
                        startIcon={<Search />}
                        onClick={() => handleSearch(1)}
                        disabled={loading}
                        fullWidth
                      >
                        {loading ? <CircularProgress size={20} /> : 'Search'}
                      </Button>
                      <Button
                        variant="outlined"
                        startIcon={<Clear />}
                        onClick={handleClearSearch}
                        fullWidth
                      >
                        Clear
                      </Button>
                    </Box>
                  </Grid>
                </Grid>
              </AccordionDetails>
            </Accordion>
          </CardContent>
        </Card>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <Card>
            <CardContent>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Box display="flex" alignItems="center" gap={2}>
                  <Typography variant="h6">
                    Search Results ({pagination.total.toLocaleString()} emails)
                  </Typography>
                  {selectedEmails.length > 0 && (
                    <Chip
                      label={`${selectedEmails.length} selected`}
                      color="primary"
                      size="small"
                    />
                  )}
                </Box>
                <Box display="flex" alignItems="center" gap={1}>
                  {selectedEmails.length > 0 && (
                    <Button
                      variant="contained"
                      color="error"
                      startIcon={bulkDeleteLoading ? <CircularProgress size={16} /> : <DeleteSweep />}
                      onClick={handleBulkDelete}
                      disabled={bulkDeleteLoading}
                      size="small"
                    >
                      {bulkDeleteLoading ? 'Deleting...' : `Delete ${selectedEmails.length}`}
                    </Button>
                  )}
                  <Typography variant="body2" color="text.secondary">
                    Page {pagination.page} of {pagination.pages}
                  </Typography>
                </Box>
              </Box>

              <DataGrid
                key={`${pagination.page}-${pagination.limit}`}
                rows={searchResults}
                columns={columns}
                autoHeight
                disableRowSelectionOnClick
                loading={loading}
                pagination
                paginationMode="server"
                rowCount={pagination.total}
                paginationModel={{
                  page: pagination.page - 1,  // DataGrid v6 uses 0-based
                  pageSize: pagination.limit,
                }}
                onPaginationModelChange={(model) => {
                  const newPage = model.page + 1;  // Convert to 1-based for backend
                  const newLimit = model.pageSize;
                  
                  // Update pagination state
                  setPagination(prev => ({
                    ...prev,
                    page: newPage,
                    limit: newLimit,
                  }));
                  
                  // Fetch new data
                  handleSearchWithLimit(newPage, newLimit);
                }}
                pageSizeOptions={[10, 25, 50, 100]}
                hideFooterSelectedRowCount
                sx={{
                  '& .MuiDataGrid-footerContainer': {
                    minHeight: '52px',
                  },
                }}
              />
            </CardContent>
          </Card>
        )}

        {/* Email Detail Dialog (Raw View) */}
        <Dialog
          open={emailDialog.open}
          onClose={() => setEmailDialog({ open: false, email: null, preview: null, loading: false })}
          maxWidth="md"
          fullWidth
        >
          <DialogTitle>
            Raw Email: {emailDialog.email?.subject || 'Email Details'}
          </DialogTitle>
          <DialogContent>
            {emailDialog.loading ? (
              <Box display="flex" justifyContent="center" p={4}>
                <CircularProgress />
              </Box>
            ) : emailDialog.preview ? (
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  From: {emailDialog.email?.from_email}
                </Typography>
                <Typography variant="subtitle2" gutterBottom>
                  To: {emailDialog.email?.to_email}
                </Typography>
                <Typography variant="subtitle2" gutterBottom>
                  Date: {emailDialog.email?.date ? new Date(emailDialog.email.date).toLocaleString() : ''}
                </Typography>
                <Typography variant="subtitle2" gutterBottom>
                  Size: {emailDialog.email?.size ? `${(emailDialog.email.size / 1024).toFixed(1)} KB` : ''}
                </Typography>

                <Divider sx={{ my: 2 }} />

                <Typography variant="h6" gutterBottom>
                  Raw Content ({emailDialog.preview.contentType})
                </Typography>

                <Paper sx={{ p: 2, maxHeight: 400, overflow: 'auto' }}>
                  {emailDialog.preview.contentType?.includes('html') ? (
                    <div dangerouslySetInnerHTML={{ __html: emailDialog.preview.body }} />
                  ) : (
                    <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                      {emailDialog.preview.body}
                    </pre>
                  )}
                </Paper>
              </Box>
            ) : (
              <Alert severity="error">
                Failed to load email preview
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setEmailDialog({ open: false, email: null, preview: null, loading: false })}
            >
              Close
            </Button>
            {emailDialog.email && (
              <Button
                variant="contained"
                startIcon={<Download />}
                onClick={() => handleDownloadEmail(emailDialog.email)}
              >
                Download EML
              </Button>
            )}
          </DialogActions>
        </Dialog>

        {/* Readable Email Viewer Dialog */}
        <Dialog
          open={readableEmailDialog.open}
          onClose={() => setReadableEmailDialog({ open: false, email: null, fullEmail: null, attachments: [], loading: false })}
          maxWidth="lg"
          fullWidth
          maxHeight="90vh"
        >
          <DialogTitle>
            <Box display="flex" alignItems="center" gap={1}>
              <Email />
              {readableEmailDialog.email?.subject || 'Email Viewer'}
            </Box>
          </DialogTitle>
          <DialogContent>
            {readableEmailDialog.loading ? (
              <Box display="flex" justifyContent="center" p={4}>
                <CircularProgress />
              </Box>
            ) : readableEmailDialog.fullEmail ? (
              <Box>
                {/* Email Header */}
                <Paper sx={{ p: 2, mb: 2, backgroundColor: '#f5f5f5' }}>
                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <Typography variant="body2" color="text.secondary">
                        From:
                      </Typography>
                      <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                        {readableEmailDialog.fullEmail.from_email}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="body2" color="text.secondary">
                        To:
                      </Typography>
                      <Typography variant="body1">
                        {readableEmailDialog.fullEmail.to_email}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="body2" color="text.secondary">
                        Date:
                      </Typography>
                      <Typography variant="body1">
                        {readableEmailDialog.fullEmail.date ? new Date(readableEmailDialog.fullEmail.date).toLocaleString() : 'Unknown'}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="body2" color="text.secondary">
                        Size:
                      </Typography>
                      <Typography variant="body1">
                        {readableEmailDialog.fullEmail.size ? `${(readableEmailDialog.fullEmail.size / 1024).toFixed(1)} KB` : 'Unknown'}
                      </Typography>
                    </Grid>
                  </Grid>
                </Paper>

                {/* Attachments Section */}
                {readableEmailDialog.attachments && readableEmailDialog.attachments.length > 0 && (
                  <Paper sx={{ p: 2, mb: 2, border: '1px solid #e0e0e0' }}>
                    <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AttachFile />
                      Attachments ({readableEmailDialog.attachments.length})
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {readableEmailDialog.attachments.map((attachment, index) => (
                        <Box
                          key={index}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            p: 1,
                            border: '1px solid #e0e0e0',
                            borderRadius: '4px',
                            backgroundColor: '#fafafa'
                          }}
                        >
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="body2" sx={{ fontWeight: 'medium', mb: 0.5 }}>
                              {attachment.filename}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {(attachment.size / 1024).toFixed(1)} KB • {attachment.mime_type || 'Unknown type'}
                            </Typography>
                          </Box>
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <Tooltip title="View Attachment">
                              <IconButton
                                size="small"
                                onClick={() => handleViewAttachment(readableEmailDialog.email.id, attachment)}
                                color="primary"
                              >
                                <RemoveRedEye fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Download Attachment">
                              <IconButton
                                size="small"
                                onClick={() => handleDownloadAttachment(readableEmailDialog.email.id, attachment)}
                                color="secondary"
                              >
                                <Download fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  </Paper>
                )}

                {/* Email Content */}
                <Typography variant="h6" gutterBottom>
                  Message Content
                </Typography>
                <Paper sx={{
                  p: 0,
                  maxHeight: '60vh',
                  overflow: 'auto',
                  backgroundColor: '#ffffff',
                  border: '1px solid #dadce0',
                  borderRadius: '8px'
                }}>
                  <Box sx={{
                    p: 3,
                    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
                    fontSize: '14px',
                    lineHeight: 1.5,
                    color: '#202124',
                    '& img': {
                      maxWidth: '100%',
                      height: 'auto'
                    },
                    '& a': {
                      color: '#1a73e8',
                      textDecoration: 'none',
                      '&:hover': {
                        textDecoration: 'underline'
                      }
                    },
                    '& blockquote': {
                      borderLeft: '4px solid #dadce0',
                      paddingLeft: '16px',
                      margin: '16px 0',
                      color: '#5f6368',
                      fontStyle: 'italic'
                    },
                    '& pre': {
                      backgroundColor: '#f1f3f4',
                      padding: '12px',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '13px',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap'
                    },
                    '& table': {
                      borderCollapse: 'collapse',
                      width: '100%',
                      margin: '16px 0'
                    },
                    '& th, & td': {
                      border: '1px solid #dadce0',
                      padding: '8px 12px',
                      textAlign: 'left'
                    },
                    '& th': {
                      backgroundColor: '#f8f9fa',
                      fontWeight: 'bold'
                    }
                  }}>
                    {/* Display email body content */}
                    {readableEmailDialog.fullEmail.body_html ? (
                      <div
                        dangerouslySetInnerHTML={{
                          __html: readableEmailDialog.fullEmail.body_html
                        }}
                        style={{
                          wordWrap: 'break-word',
                          overflowWrap: 'break-word'
                        }}
                      />
                    ) : readableEmailDialog.fullEmail.body_text ? (
                      <div style={{
                        whiteSpace: 'pre-wrap',
                        wordWrap: 'break-word',
                        overflowWrap: 'break-word'
                      }}>
                        {readableEmailDialog.fullEmail.body_text}
                      </div>
                    ) : (
                      <Typography variant="body2" sx={{ color: '#5f6368', fontStyle: 'italic' }}>
                        No content available for this email.
                      </Typography>
                    )}

                    {/* Show additional metadata for debugging if needed */}
                    {process.env.NODE_ENV === 'development' && (
                      <Box sx={{
                        mt: 3,
                        pt: 2,
                        borderTop: '1px solid #dadce0',
                        fontSize: '12px',
                        color: '#5f6368'
                      }}>
                        <Typography variant="caption" display="block">
                          Message ID: {readableEmailDialog.fullEmail.message_id}
                        </Typography>
                        <Typography variant="caption" display="block">
                          Content-Type: {readableEmailDialog.fullEmail.content_type || 'Unknown'}
                        </Typography>
                        {readableEmailDialog.email?.user_email && (
                          <Typography variant="caption" display="block">
                            User: {readableEmailDialog.email.user_email}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </Box>
                </Paper>
              </Box>
            ) : (
              <Alert severity="error">
                Failed to load email details
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setReadableEmailDialog({ open: false, email: null, fullEmail: null, attachments: [], loading: false })}
            >
              Close
            </Button>
            {readableEmailDialog.email && (
              <>
                <Button
                  variant="outlined"
                  startIcon={<Visibility />}
                  onClick={() => {
                    setReadableEmailDialog(prev => ({ ...prev, open: false }));
                    handleViewEmail(readableEmailDialog.email);
                  }}
                >
                  View Raw
                </Button>
                <Button
                  variant="contained"
                  startIcon={<Download />}
                  onClick={() => handleDownloadEmail(readableEmailDialog.email)}
                >
                  Download EML
                </Button>
              </>
            )}
          </DialogActions>
        </Dialog>


      </Box>
  );
}

export default Emails;
