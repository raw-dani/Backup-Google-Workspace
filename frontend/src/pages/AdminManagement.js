import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Chip,
  Paper,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import {
  Add,
  Delete,
  Edit,
  Refresh,
  LockReset,
  Security,
} from '@mui/icons-material';
import { authAPI } from '../services/api';

function AdminManagement() {
  const [admins, setAdmins] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Dialog states
  const [createDialog, setCreateDialog] = useState({ open: false, loading: false });
  const [resetPasswordDialog, setResetPasswordDialog] = useState({ open: false, admin: null, loading: false });
  const [editRoleDialog, setEditRoleDialog] = useState({ open: false, admin: null, loading: false });
  const [deleteDialog, setDeleteDialog] = useState({ open: false, admin: null, loading: false });

  // Form states
  const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'admin' });
  const [resetForm, setResetForm] = useState({ newPassword: '' });
  const [editRoleForm, setEditRoleForm] = useState({ newRole: '' });

  useEffect(() => {
    loadCurrentUser();
    loadAdmins();
  }, []);

  const loadCurrentUser = async () => {
    try {
      const response = await authAPI.getMe();
      setCurrentUser(response.data.user);
    } catch (error) {
      console.error('Failed to load current user:', error);
    }
  };

  const loadAdmins = async () => {
    try {
      setLoading(true);
      const response = await authAPI.getAdminList();
      setAdmins(response.data.admins || []);
      setError('');
    } catch (error) {
      console.error('Failed to load admins:', error);
      setError('Failed to load admin list. You may not have permission (super_admin only).');
    } finally {
      setLoading(false);
    }
  };

  const isSuperAdmin = currentUser?.role === 'super_admin';

  const handleCreateAdmin = async () => {
    try {
      setCreateDialog(prev => ({ ...prev, loading: true }));
      await authAPI.createAdmin(createForm);
      setSuccess('Admin created successfully');
      setCreateDialog({ open: false, loading: false });
      setCreateForm({ username: '', password: '', role: 'admin' });
      loadAdmins();
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to create admin');
    } finally {
      setCreateDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const handleResetPassword = async () => {
    try {
      setResetPasswordDialog(prev => ({ ...prev, loading: true }));
      await authAPI.resetAdminPassword({
        adminId: resetPasswordDialog.admin.id,
        newPassword: resetForm.newPassword
      });
      setSuccess('Password reset successfully');
      setResetPasswordDialog({ open: false, admin: null, loading: false });
      setResetForm({ newPassword: '' });
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to reset password');
    } finally {
      setResetPasswordDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const handleUpdateRole = async () => {
    try {
      setEditRoleDialog(prev => ({ ...prev, loading: true }));
      await authAPI.updateAdminRole({
        adminId: editRoleDialog.admin.id,
        newRole: editRoleForm.newRole
      });
      setSuccess('Role updated successfully');
      setEditRoleDialog({ open: false, admin: null, loading: false });
      setEditRoleForm({ newRole: '' });
      loadAdmins();
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to update role');
    } finally {
      setEditRoleDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const handleDeleteAdmin = async () => {
    try {
      setDeleteDialog(prev => ({ ...prev, loading: true }));
      await authAPI.deleteAdmin({ adminId: deleteDialog.admin.id });
      setSuccess('Admin deleted successfully');
      setDeleteDialog({ open: false, admin: null, loading: false });
      loadAdmins();
    } catch (error) {
      setError(error.response?.data?.error || 'Failed to delete admin');
    } finally {
      setDeleteDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const getRoleColor = (role) => {
    switch (role) {
      case 'super_admin': return 'error';
      case 'admin': return 'primary';
      case 'viewer': return 'default';
      default: return 'default';
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  if (!isSuperAdmin) {
    return (
      <Box p={3}>
        <Alert severity="warning">
          <Typography variant="h6">Access Denied</Typography>
          <Typography>
            Only super_admin can access this page. Your current role: {currentUser?.role || 'Unknown'}
          </Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" component="h1">
          Admin Management
        </Typography>
        <Box>
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            onClick={loadAdmins}
            sx={{ mr: 1 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={() => setCreateDialog({ open: true, loading: false })}
          >
            Add Admin
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {/* Current User Info */}
      <Paper sx={{ p: 2, mb: 3, backgroundColor: '#f5f5f5' }}>
        <Box display="flex" alignItems="center" gap={2}>
          <Security color="primary" sx={{ fontSize: 40 }} />
          <Box>
            <Typography variant="h6">
              Logged in as: {currentUser?.username}
            </Typography>
            <Chip
              label={currentUser?.role}
              color={getRoleColor(currentUser?.role)}
              size="small"
            />
          </Box>
        </Box>
      </Paper>

      {/* Admin List */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Admin Users ({admins.length})
          </Typography>

          {loading ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Username</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Last Login</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {admins.map((admin) => (
                    <TableRow key={admin.id}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={admin.id === currentUser?.id ? 'bold' : 'normal'}>
                          {admin.username}
                          {admin.id === currentUser?.id && ' (You)'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={admin.role}
                          color={getRoleColor(admin.role)}
                          size="small"
                        />
                      </TableCell>
                      <TableCell>{formatDate(admin.last_login)}</TableCell>
                      <TableCell>{formatDate(admin.created_at)}</TableCell>
                      <TableCell align="right">
                        <Tooltip title="Reset Password">
                          <IconButton
                            size="small"
                            onClick={() => {
                              setResetPasswordDialog({ open: true, admin, loading: false });
                              setResetForm({ newPassword: '' });
                            }}
                            disabled={admin.id === currentUser?.id}
                          >
                            <LockReset />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Change Role">
                          <IconButton
                            size="small"
                            onClick={() => {
                              setEditRoleDialog({ open: true, admin, loading: false });
                              setEditRoleForm({ newRole: admin.role });
                            }}
                            disabled={admin.id === currentUser?.id}
                          >
                            <Edit />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete Admin">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => setDeleteDialog({ open: true, admin, loading: false })}
                            disabled={admin.id === currentUser?.id || admin.role === 'super_admin'}
                          >
                            <Delete />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {/* Create Admin Dialog */}
      <Dialog
        open={createDialog.open}
        onClose={() => setCreateDialog({ open: false, loading: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create New Admin</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <TextField
              fullWidth
              label="Username"
              value={createForm.username}
              onChange={(e) => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
              sx={{ mb: 2 }}
            />
            <TextField
              fullWidth
              label="Password"
              type="password"
              value={createForm.password}
              onChange={(e) => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
              sx={{ mb: 2 }}
              helperText="Minimum 8 characters"
            />
            <FormControl fullWidth>
              <InputLabel>Role</InputLabel>
              <Select
                value={createForm.role}
                onChange={(e) => setCreateForm(prev => ({ ...prev, role: e.target.value }))}
                label="Role"
              >
                <MenuItem value="super_admin">Super Admin - All access including admin management</MenuItem>
                <MenuItem value="admin">Admin - All access except admin management</MenuItem>
                <MenuItem value="viewer">Viewer - Read only (cannot add domains/users)</MenuItem>
              </Select>
            </FormControl>
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
            onClick={handleCreateAdmin}
            variant="contained"
            disabled={createDialog.loading || !createForm.username || createForm.password.length < 8}
            startIcon={createDialog.loading ? <CircularProgress size={20} /> : null}
          >
            {createDialog.loading ? 'Creating...' : 'Create Admin'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog
        open={resetPasswordDialog.open}
        onClose={() => setResetPasswordDialog({ open: false, admin: null, loading: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reset Password - {resetPasswordDialog.admin?.username}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>
              This will reset the password for {resetPasswordDialog.admin?.username}
            </Alert>
            <TextField
              fullWidth
              label="New Password"
              type="password"
              value={resetForm.newPassword}
              onChange={(e) => setResetForm(prev => ({ ...prev, newPassword: e.target.value }))}
              helperText="Minimum 8 characters"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setResetPasswordDialog({ open: false, admin: null, loading: false })}
            disabled={resetPasswordDialog.loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleResetPassword}
            variant="contained"
            disabled={resetPasswordDialog.loading || resetForm.newPassword.length < 8}
            startIcon={resetPasswordDialog.loading ? <CircularProgress size={20} /> : null}
          >
            {resetPasswordDialog.loading ? 'Resetting...' : 'Reset Password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog
        open={editRoleDialog.open}
        onClose={() => setEditRoleDialog({ open: false, admin: null, loading: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Change Role - {editRoleDialog.admin?.username}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <FormControl fullWidth>
              <InputLabel>New Role</InputLabel>
              <Select
                value={editRoleForm.newRole}
                onChange={(e) => setEditRoleForm(prev => ({ ...prev, newRole: e.target.value }))}
                label="New Role"
              >
                <MenuItem value="super_admin">Super Admin - Full access including admin management</MenuItem>
                <MenuItem value="admin">Admin - Full access</MenuItem>
                <MenuItem value="viewer">Viewer - Read only</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setEditRoleDialog({ open: false, admin: null, loading: false })}
            disabled={editRoleDialog.loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpdateRole}
            variant="contained"
            disabled={editRoleDialog.loading || !editRoleForm.newRole}
            startIcon={editRoleDialog.loading ? <CircularProgress size={20} /> : null}
          >
            {editRoleDialog.loading ? 'Updating...' : 'Update Role'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, admin: null, loading: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Delete Admin</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mt: 1 }}>
            Are you sure you want to delete <strong>{deleteDialog.admin?.username}</strong>?
            This action cannot be undone.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteDialog({ open: false, admin: null, loading: false })}
            disabled={deleteDialog.loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDeleteAdmin}
            variant="contained"
            color="error"
            disabled={deleteDialog.loading}
            startIcon={deleteDialog.loading ? <CircularProgress size={20} /> : null}
          >
            {deleteDialog.loading ? 'Deleting...' : 'Delete Admin'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default AdminManagement;
