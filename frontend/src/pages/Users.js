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
  Switch,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  Delete,
  Refresh,
  Person,
  Wifi,
  WifiOff,
  Sync,
  PlayCircle,
  CheckCircle,
  Error,
  DeleteSweep,
} from '@mui/icons-material';
import { DataGrid } from '@mui/x-data-grid';
import { usersAPI, domainsAPI } from '../services/api';

function Users() {
  const [users, setUsers] = useState([]);
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    domain_id: '',
    status: '',
    search: '',
  });
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    pages: 0,
  });

  // User detail dialog
  const [userDialog, setUserDialog] = useState({
    open: false,
    user: null,
    stats: null,
    loading: false,
  });

  // Bulk operations
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [bulkImapLoading, setBulkImapLoading] = useState(false);
  const [bulkImapResults, setBulkImapResults] = useState(null);
  const [bulkImapProgress, setBulkImapProgress] = useState(null);
  const [bulkDisconnectLoading, setBulkDisconnectLoading] = useState(false);
  const [bulkDisconnectResults, setBulkDisconnectResults] = useState(null);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [bulkDeleteResults, setBulkDeleteResults] = useState(null);

  useEffect(() => {
    loadDomains();
    loadUsers();
    // Clear selection when filters or pagination change
    setSelectedUsers([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, pagination.page, pagination.limit]);

  const loadDomains = async () => {
    try {
      const response = await domainsAPI.getDomains();
      setDomains(response.data.domains);
    } catch (error) {
      console.error('Failed to load domains:', error);
    }
  };

  const loadUsers = async () => {
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

      const response = await usersAPI.getUsers(params);
      setUsers(response.data.users);
      setPagination(response.data.pagination);
      setError('');
    } catch (error) {
      console.error('Failed to load users:', error);
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (user, newStatus) => {
    try {
      // Optimistic UI update
      setUsers(prevUsers =>
        prevUsers.map(u =>
          u.id === user.id ? { ...u, status: newStatus } : u
        )
      );

      await usersAPI.updateUserStatus(user.id, { status: newStatus });

      // Refresh from server to ensure consistency
      await loadUsers();
    } catch (error) {
      console.error('Failed to update user status:', error);
      setError('Failed to update user status');

      // Revert optimistic update on error
      await loadUsers();
    }
  };

  const handleConnect = async (user) => {
    try {
      await usersAPI.connectUser(user.id);
      await loadUsers(); // Refresh to show updated connection status
    } catch (error) {
      console.error('Failed to connect user:', error);
      setError('Failed to start IMAP connection');
    }
  };

  const handleDisconnect = async (user) => {
    try {
      await usersAPI.disconnectUser(user.id);
      await loadUsers(); // Refresh to show updated connection status
    } catch (error) {
      console.error('Failed to disconnect user:', error);
      setError('Failed to stop IMAP connection');
    }
  };

  const [manualBackupProgress, setManualBackupProgress] = useState(null);

  const handleManualBackup = async (user) => {
    try {
      setError(''); // Clear any previous errors

      // Check if any backup operation is currently running
      const backupStatusResponse = await usersAPI.getBackupStatus();
      const backupStatus = backupStatusResponse.data.status;

      if (backupStatus.anyBackupRunning) {
        const runningOperations = [];
        if (backupStatus.isRunning) runningOperations.push('Scheduled Backup');
        if (backupStatus.manualBackupRunning) runningOperations.push('Manual Backup');
        if (backupStatus.bulkImapRunning) runningOperations.push('Bulk IMAP');

        alert(`❌ Cannot start manual backup: ${runningOperations.join(', ')} is currently running. Please wait for completion.`);
        return;
      }

      // Start backup
      const response = await usersAPI.runManualBackup(user.id);

      if (response.data.status === 'running') {
        // Show progress dialog
        setManualBackupProgress({
          user: user,
          backupId: response.data.backupId,
          status: 'running',
          message: 'Starting manual backup...',
          startTime: Date.now()
        });

        // Start polling for status
        pollBackupStatus(user, response.data.backupId);
      } else {
        // Handle immediate errors
        alert(`❌ ${response.data.error || 'Failed to start manual backup'}`);
      }
    } catch (error) {
      console.error('Failed to start manual backup:', error);
      setError('Failed to start manual backup');

      if (error.response?.status === 409) {
        alert(`⚠️ ${error.response.data.error}`);
      } else {
        alert(`❌ Failed to start manual backup for ${user.email}`);
      }
    }
  };

  const pollBackupStatus = async (user, backupId) => {
    const startTime = Date.now();
    const pollInterval = setInterval(async () => {
      try {
        const response = await usersAPI.getManualBackupStatus(user.id);
        const status = response.data;

        setManualBackupProgress(prev => ({
          ...prev,
          status: status.status,
          message: status.message,
          progress: status.progress,
          lastActivity: status.lastActivity
        }));

        // Check if backup completed or failed
        if (status.status === 'completed') {
          clearInterval(pollInterval);
          setManualBackupProgress(null);
          alert(`✅ Manual backup completed successfully for ${user.email}`);
          loadUsers(); // Refresh to show updated data
        } else if (status.status === 'failed') {
          clearInterval(pollInterval);
          setManualBackupProgress(null);
          alert(`❌ Manual backup failed for ${user.email}. ${status.message}`);
          loadUsers(); // Refresh to show updated data
        } else if (status.status === 'idle') {
          // Check if it's been idle for a while (backup might be finished)
          const elapsed = Date.now() - startTime;
          if (elapsed > 2 * 60 * 1000) { // 2 minutes of idle status
            clearInterval(pollInterval);
            setManualBackupProgress(null);
            alert(`✅ Manual backup appears to be completed for ${user.email}`);
            loadUsers();
          }
        }
      } catch (error) {
        console.error('Failed to poll backup status:', error);
        // Continue polling, don't stop on polling errors
      }
    }, 3000); // Poll every 3 seconds

    // Stop polling after 30 minutes (safety timeout)
    setTimeout(() => {
      clearInterval(pollInterval);
      setManualBackupProgress(null);
      alert(`⏰ Manual backup timeout for ${user.email}. The backup may still be running in the background.`);
      loadUsers();
    }, 30 * 60 * 1000); // 30 minutes
  };

  // HYBRID APPROACH: Determine optimal processing strategy based on user count and mailbox sizes
  const determineProcessingStrategy = (eligibleUsers, initialCounts) => {
    const userCount = eligibleUsers.length;

    // Calculate average mailbox size
    let totalEmails = 0;
    let knownUsers = 0;
    eligibleUsers.forEach(user => {
      const emailCount = initialCounts[user.id] || 0;
      if (emailCount > 0) {
        totalEmails += emailCount;
        knownUsers++;
      }
    });

    const avgMailboxSize = knownUsers > 0 ? totalEmails / knownUsers : 0;
    const hasLargeMailboxes = avgMailboxSize > 5000; // > 5K emails = large

    console.log(`📊 Strategy Analysis: ${userCount} users, avg ${Math.round(avgMailboxSize)} emails, ${hasLargeMailboxes ? 'large' : 'normal'} mailboxes`);

    // Decision Tree for Processing Strategy
    if (userCount <= 5) {
      // Small batch: Always parallel for speed
      return {
        mode: 'parallel',
        batchSize: userCount, // All at once
        concurrency: userCount,
        reason: 'Small user count - parallel processing optimal'
      };
    } else if (userCount <= 15 && !hasLargeMailboxes) {
      // Medium batch, small mailboxes: Controlled parallel
      return {
        mode: 'parallel',
        batchSize: 3,
        concurrency: 3,
        reason: 'Medium user count with normal mailboxes - controlled parallel'
      };
    } else if (userCount <= 25 && hasLargeMailboxes) {
      // Large mailboxes: Sequential with optimizations
      return {
        mode: 'sequential_optimized',
        batchSize: 1,
        concurrency: 1,
        reason: 'Large mailboxes detected - sequential for Gmail compliance'
      };
    } else {
      // Very large batch: Sequential
      return {
        mode: 'sequential',
        batchSize: 1,
        concurrency: 1,
        reason: 'Large user count - sequential processing required'
      };
    }
  };

  // ENHANCED: Check if user has emails to sync using smart comparison
  const checkUserHasEmailsToSync = async (userId, userEmail) => {
    try {
      const response = await usersAPI.checkUserHasEmailsToSync(userId);
      return response.data.hasEmailsToSync;
    } catch (error) {
      console.error(`❌ Error checking sync status for ${userEmail}:`, error);
      // If we can't determine, assume we need to sync
      return true;
    }
  };

  const pollBulkImapStatus = async (eligibleUsers, results, initialCounts, onUserComplete, onComplete, onError) => {
    let currentUserIndex = 0;
    const startTime = Date.now();
    let isProcessingComplete = false;

    // HYBRID APPROACH: Determine processing strategy based on user count and mailbox sizes
    const processingStrategy = determineProcessingStrategy(eligibleUsers, initialCounts);

    console.log(`🎯 Bulk IMAP Strategy: ${processingStrategy.mode} (batchSize: ${processingStrategy.batchSize}, concurrency: ${processingStrategy.concurrency})`);

    // Get Gmail message counts for all users at the start for comparison
    const gmailCounts = {};
    try {
      const countPromises = eligibleUsers.map(async (user) => {
        try {
          const response = await usersAPI.getGmailMessageCount(user.id);
          return { userId: user.id, count: response.data.totalMessages || 0 };
        } catch (error) {
          console.warn(`Could not get Gmail count for ${user.email}:`, error);
          return { userId: user.id, count: -1 }; // Unknown count
        }
      });

      const countResults = await Promise.allSettled(countPromises);
      countResults.forEach(result => {
        if (result.status === 'fulfilled') {
          gmailCounts[result.value.userId] = result.value.count;
          console.log(`Gmail count for user ${result.value.userId}: ${result.value.count}`);
        } else {
          console.error('Failed to get Gmail count:', result.reason);
        }
      });
    } catch (error) {
      console.error('Error getting Gmail counts:', error);
      // Continue with unknown counts
    }

    const processNextUser = async () => {
      // Check if processing is already complete
      if (isProcessingComplete || currentUserIndex >= eligibleUsers.length) {
        if (!isProcessingComplete) {
          isProcessingComplete = true;
          console.log('All users processed, calling onComplete');
          onComplete(results);
        }
        return;
      }

      const user = eligibleUsers[currentUserIndex];
      const initialCount = initialCounts[user.id] || 0;
      const gmailCount = gmailCounts[user.id] || -1;

      // Calculate dynamic timeout based on mailbox size (with safety bounds)
      const baseTimeout = 3 * 60 * 1000; // 3 minutes base
      const perEmailTimeout = 200; // 200ms per email
      const maxTimeout = 15 * 60 * 1000; // 15 minutes max
      const dynamicTimeout = Math.min(
        maxTimeout,
        Math.max(baseTimeout, gmailCount > 0 ? gmailCount * perEmailTimeout : baseTimeout)
      );

      console.log(`Processing user ${currentUserIndex + 1}/${eligibleUsers.length}: ${user.email} (timeout: ${Math.round(dynamicTimeout / 1000)}s, Gmail: ${gmailCount}, DB: ${initialCount})`);

      try {
        // ENHANCED: Check if user has emails to sync using smart comparison
        const hasEmailsToSync = await checkUserHasEmailsToSync(user.id, user.email);

        if (!hasEmailsToSync) {
          console.log(`✅ Skipping user ${user.email} - already fully synced`);
          results.push({
            user: user.email,
            status: 'skipped',
            message: 'Already fully synced - no emails to download'
          });
          currentUserIndex++;
          // Start next user immediately for first few users, then add small delay
          const delay = currentUserIndex < 3 ? 0 : 100;
          setTimeout(processNextUser, delay);
          return;
        }

        // Start IMAP connection for current user
        console.log(`Starting IMAP connection for ${user.email}`);
        await usersAPI.connectUser(user.id);

        results.push({
          user: user.email,
          status: 'in_progress',
          message: 'IMAP connection started - monitoring progress...'
        });

        // Update progress
        setBulkImapProgress({
          user: user,
          results: [...results],
          currentUserIndex: currentUserIndex,
          totalUsers: eligibleUsers.length,
          status: 'running',
          message: `Processing ${user.email}... (0/${gmailCount > 0 ? gmailCount : '?'})`,
          startTime: Date.now()
        });

        // Process this user with polling
        await processUserWithPolling(user, initialCount, gmailCount, dynamicTimeout, results);

      } catch (error) {
        console.error(`Failed to start IMAP for ${user.email}:`, error);
        results.push({
          user: user.email,
          status: 'error',
          message: error.response?.data?.error || error.message || 'Unknown error'
        });
      }

      // Move to next user
      currentUserIndex++;
      // Start next user immediately for first few users, then add small delay
      const delay = currentUserIndex < 3 ? 0 : 100;
      setTimeout(processNextUser, delay);
    };

    // Helper function to process a single user with polling
    const processUserWithPolling = async (user, initialCount, gmailCount, timeoutMs, results) => {
      return new Promise((resolve) => {
        const userStartTime = Date.now();
        let lastProgressUpdate = 0;
        let pollingActive = true;

        console.log(`Starting polling for ${user.email} with ${timeoutMs}ms timeout`);

        const pollInterval = setInterval(async () => {
          if (!pollingActive) return;

          try {
            const response = await usersAPI.getUserStats(user.id);
            const stats = response.data.stats || {};
            const connection = response.data.connection;
            const currentCount = stats.total_emails || 0;
            const progress = Math.max(0, currentCount - initialCount); // Ensure non-negative

            // Update progress every 5 seconds
            const now = Date.now();
            if (now - lastProgressUpdate > 5000) {
              const progressText = gmailCount > 0
                ? `${progress}/${gmailCount} emails (${Math.min(100, Math.round(progress/gmailCount*100))}%)`
                : `${progress} emails downloaded`;

              setBulkImapProgress(prev => ({
                ...prev,
                message: `Processing ${user.email} - ${progressText}`,
                results: [...results] // Fresh copy
              }));
              lastProgressUpdate = now;
            }

            // Check completion conditions
            const isFullySynced = gmailCount > 0 && currentCount >= gmailCount;
            const hasEnoughEmails = progress >= Math.min(100, Math.max(10, gmailCount > 0 ? gmailCount * 0.1 : 50));
            const isIdle = connection && connection.status === 'idle' && !connection.isRecent;
            const timeElapsed = now - userStartTime;
            const shouldTimeout = timeElapsed > timeoutMs;

            if (isFullySynced || (hasEnoughEmails && isIdle) || shouldTimeout) {
              pollingActive = false;
              clearInterval(pollInterval);

              let finalStatus = 'success';
              let finalMessage = '';

              if (isFullySynced) {
                finalMessage = `✅ Fully synced: ${currentCount}/${gmailCount} emails (100%)`;
              } else if (hasEnoughEmails && isIdle) {
                finalMessage = `✅ Sufficient sync: ${progress} emails downloaded, connection idle`;
              } else if (shouldTimeout) {
                finalMessage = `⏰ Timeout: ${progress} emails downloaded (${Math.round(timeElapsed/1000)}s)`;
              }

              console.log(`Completed processing ${user.email}: ${finalMessage}`);

              // Update result safely
              const resultIndex = results.findIndex(r => r.user === user.email);
              if (resultIndex !== -1) {
                results[resultIndex] = {
                  ...results[resultIndex],
                  status: finalStatus,
                  message: finalMessage
                };
              }

              // Call completion callback
              onUserComplete(user, results);
              resolve();
            }
          } catch (error) {
            console.error(`Polling error for ${user.email}:`, error);
            // Continue polling on errors, don't stop
          }
        }, 3000); // Poll every 3 seconds

        // Safety timeout
        const timeoutHandle = setTimeout(() => {
          if (pollingActive) {
            pollingActive = false;
            clearInterval(pollInterval);

            const timeElapsed = Date.now() - userStartTime;
            const resultIndex = results.findIndex(r => r.user === user.email);

            if (resultIndex !== -1 && results[resultIndex].status === 'in_progress') {
              results[resultIndex] = {
                ...results[resultIndex],
                status: 'success',
                message: `⏰ Timeout: processed for ${Math.round(timeElapsed/1000)}s`
              };
            }

            console.log(`Timeout reached for ${user.email} after ${Math.round(timeElapsed/1000)}s`);
            onUserComplete(user, results);
            resolve();
          }
        }, timeoutMs);
      });
    };

    // Start processing
    console.log(`Starting bulk IMAP processing for ${eligibleUsers.length} users`);
    processNextUser();

    // Overall safety timeout (60 minutes)
    const overallTimeout = setTimeout(() => {
      if (!isProcessingComplete) {
        isProcessingComplete = true;
        console.error('Overall timeout reached for bulk IMAP processing');
        setBulkImapProgress(null);
        alert(`⏰ Bulk IMAP processing overall timeout. ${currentUserIndex} of ${eligibleUsers.length} users processed.`);
        loadUsers();
      }
    }, 60 * 60 * 1000); // 60 minutes

    // Clear overall timeout when complete
    const originalOnComplete = onComplete;
    onComplete = (results) => {
      clearTimeout(overallTimeout);
      originalOnComplete(results);
    };
  };

  const handleDeleteUser = async (user) => {
    // Check if user is still active (sync enabled)
    if (user.status === 'active') {
      alert(`❌ Cannot delete user "${user.email}" while sync is still active.\n\nPlease deactivate the user first by turning off the sync toggle, then try deleting again.`);
      return;
    }

    // Enhanced confirmation with more details
    const confirmMessage = `
Delete User: ${user.email}

This action will permanently delete:
• User account and settings
• All backed up emails (${user.email_count || 0} emails)
• All email attachments
• IMAP connection history
• PST export history

This action CANNOT be undone!

Are you sure you want to proceed?
    `.trim();

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // Secondary confirmation for users with emails
    if (user.email_count > 0) {
      const secondaryConfirm = `⚠️ WARNING: This user has ${user.email_count} backed up emails and ${user.total_size ? (user.total_size / (1024 * 1024)).toFixed(1) : 0} MB of data.

Are you ABSOLUTELY sure you want to delete everything?`;
      if (!window.confirm(secondaryConfirm)) {
        return;
      }
    }

    try {
      setError(''); // Clear any previous errors

      await usersAPI.deleteUser(user.id);

      // Success message
      alert(`✅ User "${user.email}" has been successfully deleted along with all associated data.`);

      // Refresh the user list
      await loadUsers();

    } catch (error) {
      console.error('Failed to delete user:', error);

      // More specific error messages
      let errorMessage = 'Failed to delete user';
      if (error.response?.status === 404) {
        errorMessage = 'User not found - may have been already deleted';
      } else if (error.response?.status === 500) {
        errorMessage = 'Server error occurred while deleting user';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      }

      setError(errorMessage);
      alert(`❌ ${errorMessage}`);
    }
  };

  const handleViewUser = async (user) => {
    try {
      setUserDialog({ open: true, user, stats: null, loading: true });

      const [userDetails, userStats] = await Promise.all([
        usersAPI.getUser(user.id),
        usersAPI.getUserStats(user.id),
      ]);

      setUserDialog({
        open: true,
        user: userDetails.data.user,
        stats: userStats.data,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to load user details:', error);
      setUserDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const getConnectionStatusColor = (connection) => {
    if (!connection) return 'default';

    const { status, isRecent } = connection;
    if (status === 'connected' && isRecent) return 'success';
    if (status === 'connecting') return 'warning';
    if (status === 'idle' && isRecent) return 'info';
    return 'error';
  };

  const getConnectionStatusIcon = (connection) => {
    if (!connection) return <WifiOff color="disabled" />;

    const { status, isRecent } = connection;
    if (status === 'connected' && isRecent) return <Wifi color="success" />;
    if (status === 'idle' && isRecent) return <Wifi color="info" />;
    if (status === 'connecting') return <Wifi color="warning" />;
    return <WifiOff color="error" />;
  };

  const getConnectionStatusText = (connection) => {
    if (!connection) return 'No Data';

    const { status, isRecent, timeSinceActivity } = connection;

    if (status === 'connected' && isRecent) {
      return `Connected (${Math.floor(timeSinceActivity / 60)}m ago)`;
    }
    if (status === 'idle' && isRecent) {
      return `Idle (${Math.floor(timeSinceActivity / 60)}m ago)`;
    }
    if (status === 'connecting') {
      return 'Connecting...';
    }
    if (!isRecent) {
      return `${status} (${Math.floor(timeSinceActivity / 3600)}h ago)`;
    }

    return status;
  };

  // Direct bulk IMAP processing (instant execution)
  const handleDirectBulkImapStart = async () => {
    if (selectedUsers.length === 0) {
      setError('No users selected for IMAP connection');
      return;
    }

    // Check if any backup operation is currently running
    try {
      const backupStatusResponse = await usersAPI.getBackupStatus();
      const backupStatus = backupStatusResponse.data.status;

      if (backupStatus.anyBackupRunning) {
        const runningOperations = [];
        if (backupStatus.isRunning) runningOperations.push('Scheduled Backup');
        if (backupStatus.manualBackupRunning) runningOperations.push('Manual Backup');
        if (backupStatus.bulkImapRunning) runningOperations.push('Bulk IMAP');

        alert(`❌ Cannot start bulk IMAP: ${runningOperations.join(', ')} is currently running. Please wait for completion.`);
        return;
      }
    } catch (error) {
      console.error('Failed to check backup status:', error);
      alert('❌ Unable to verify backup status. Please try again.');
      return;
    }

    // DEBUG: Log all selected users
    console.log('DEBUG: All selected users:', selectedUsers.map(u => u.email));

    // Filter only active users that are not already connected
    // PERBAIKAN: Gunakan data terbaru dari users state
    const eligibleUsers = selectedUsers.filter(selectedUser => {
      const currentUser = users.find(u => u.id === selectedUser.id);
      if (!currentUser) {
        console.warn(`User ${selectedUser.id} not found in current users data`);
        return false;
      }
      return currentUser.status === 'active' &&
             (!currentUser.connection || currentUser.connection.status === 'disconnected');
    });

    // DEBUG: Log eligible users
    console.log('DEBUG: Eligible users for processing:', eligibleUsers.map(u => u.email));

    if (eligibleUsers.length === 0) {
      setError('No eligible users selected. Users must be active and not already connected.');
      return;
    }

    const confirmMessage = `Start INSTANT bulk IMAP connections for ${eligibleUsers.length} selected user(s)?

${eligibleUsers.map(u => `• ${u.email}`).join('\n')}

This will start IMAP synchronization for ALL selected users IMMEDIATELY, bypassing the queue service. Users who are already fully synced will be skipped automatically. This ensures instant execution without waiting for scheduled backups.`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setBulkImapLoading(true);
      setBulkImapResults(null);
      setBulkImapProgress(null);
      setError('');

      // Show immediate processing dialog
      setBulkImapProgress({
        user: null,
        results: [],
        currentUserIndex: 0,
        totalUsers: eligibleUsers.length,
        status: 'starting',
        message: `Starting instant bulk IMAP processing for ${eligibleUsers.length} users...`,
        startTime: Date.now()
      });

      // Use direct bulk processing endpoint (bypasses queue service entirely)
      const userIds = eligibleUsers.map(user => user.id);
      const response = await usersAPI.startDirectBulkImap(userIds);

      console.log('Direct bulk IMAP processing completed:', response.data);

      // Show completion results
      setBulkImapResults({
        total: eligibleUsers.length,
        success: eligibleUsers.length, // All users processed
        error: 0,
        skipped: 0,
        results: eligibleUsers.map(user => ({
          user: user.email,
          status: 'success',
          message: 'IMAP connection started successfully (instant execution)'
        })),
        completed: true
      });

      // Clear progress and refresh
      setBulkImapProgress(null);
      setSelectedUsers([]);
      await loadUsers();

      // Show success message
      alert(`✅ Instant bulk IMAP processing completed!\n\n${eligibleUsers.length} users started IMAP connections immediately without queue delays.`);

    } catch (error) {
      console.error('Direct bulk IMAP failed:', error);
      setError('Failed to start direct bulk IMAP connections');
      setBulkImapProgress(null);
      setBulkImapLoading(false);

      // Try to release locks
      try {
        await usersAPI.endBulkImap();
      } catch (endError) {
        console.error('Failed to release bulk IMAP locks:', endError);
      }

      alert(`❌ Failed to start instant bulk IMAP: ${error.response?.data?.error || error.message}`);
    }
  };

  // Updated bulk IMAP start handler that uses direct processing
  const handleBulkImapStart = handleDirectBulkImapStart;

  const handleBulkImapDisconnect = async () => {
    if (selectedUsers.length === 0) {
      setError('No users selected for IMAP disconnection');
      return;
    }

    // Filter only users that are currently connected
    const eligibleUsers = selectedUsers.filter(user =>
      user.connection && user.connection.status !== 'disconnected'
    );

    if (eligibleUsers.length === 0) {
      setError('No eligible users selected. Users must be currently connected to IMAP.');
      return;
    }

    const confirmMessage = `Stop IMAP connections for ${eligibleUsers.length} selected user(s)?

${eligibleUsers.map(u => `• ${u.email}`).join('\n')}

This will stop IMAP synchronization for these users.`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setBulkDisconnectLoading(true);
      setBulkDisconnectResults(null);
      setError('');

      const results = [];
      let successCount = 0;
      let errorCount = 0;

      // Process users sequentially
      for (const user of eligibleUsers) {
        try {
          await usersAPI.disconnectUser(user.id);
          results.push({
            user: user.email,
            status: 'success',
            message: 'IMAP connection stopped'
          });
          successCount++;
        } catch (error) {
          console.error(`Failed to stop IMAP for ${user.email}:`, error);
          results.push({
            user: user.email,
            status: 'error',
            message: error.response?.data?.error || error.message
          });
          errorCount++;
        }
      }

      setBulkDisconnectResults({
        total: eligibleUsers.length,
        success: successCount,
        error: errorCount,
        results: results
      });

      // Clear selection and refresh
      setSelectedUsers([]);
      await loadUsers();

      // Show summary alert
      if (errorCount === 0) {
        alert(`✅ Successfully stopped IMAP connections for all ${successCount} users!`);
      } else if (successCount === 0) {
        alert(`❌ Failed to stop IMAP connections for all ${errorCount} users.`);
      } else {
        alert(`⚠️ Partial success: ${successCount} succeeded, ${errorCount} failed.`);
      }

    } catch (error) {
      console.error('Bulk IMAP disconnect failed:', error);
      setError('Failed to stop bulk IMAP connections');
    } finally {
      setBulkDisconnectLoading(false);
    }
  };

  const handleBulkDeleteUsers = async () => {
    if (selectedUsers.length === 0) {
      setError('No users selected for deletion');
      return;
    }

    // Filter only inactive users (users with active sync cannot be deleted)
    const eligibleUsers = selectedUsers.filter(user => user.status === 'inactive');

    if (eligibleUsers.length === 0) {
      setError('No eligible users selected. Users must be inactive (sync disabled) to be deleted.');
      return;
    }

    const totalEmails = eligibleUsers.reduce((sum, user) => sum + (user.email_count || 0), 0);
    const totalSize = eligibleUsers.reduce((sum, user) => sum + (user.total_size || 0), 0);

    // Enhanced confirmation
    const confirmMessage = `Delete ${eligibleUsers.length} selected user(s)?

Users to delete:
${eligibleUsers.map(u => `• ${u.email} (${u.email_count || 0} emails)`).join('\n')}

Total data to be deleted:
• ${totalEmails.toLocaleString()} emails
• ${(totalSize / (1024 * 1024)).toFixed(1)} MB storage

⚠️  This action CANNOT be undone!
All emails, attachments, and user data will be permanently deleted.`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // Secondary confirmation for users with significant data
    if (totalEmails > 100 || totalSize > 100 * 1024 * 1024) { // 100 emails or 100MB
      const secondaryConfirm = `⚠️ WARNING: You're about to delete significant data!

• ${totalEmails.toLocaleString()} emails total
• ${(totalSize / (1024 * 1024)).toFixed(1)} MB storage

Are you ABSOLUTELY sure you want to proceed?`;
      if (!window.confirm(secondaryConfirm)) {
        return;
      }
    }

    try {
      setBulkDeleteLoading(true);
      setBulkDeleteResults(null);
      setError('');

      const results = [];
      let successCount = 0;
      let errorCount = 0;

      // Process users sequentially
      for (const user of eligibleUsers) {
        try {
          await usersAPI.deleteUser(user.id);
          results.push({
            user: user.email,
            status: 'success',
            message: 'User deleted successfully'
          });
          successCount++;
        } catch (error) {
          console.error(`Failed to delete user ${user.email}:`, error);
          results.push({
            user: user.email,
            status: 'error',
            message: error.response?.data?.error || error.message
          });
          errorCount++;
        }
      }

      setBulkDeleteResults({
        total: eligibleUsers.length,
        success: successCount,
        error: errorCount,
        results: results
      });

      // Clear selection and refresh
      setSelectedUsers([]);
      await loadUsers();

      // Show summary alert
      if (errorCount === 0) {
        alert(`✅ Successfully deleted ${successCount} users and all their data!`);
      } else if (successCount === 0) {
        alert(`❌ Failed to delete all ${errorCount} users.`);
      } else {
        alert(`⚠️ Partial success: ${successCount} deleted, ${errorCount} failed.`);
      }

    } catch (error) {
      console.error('Bulk delete failed:', error);
      setError('Failed to delete selected users');
    } finally {
      setBulkDeleteLoading(false);
    }
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedUsers(users);
    } else {
      setSelectedUsers([]);
    }
  };

  const handleUserSelection = (user, checked) => {
    if (checked) {
      setSelectedUsers(prev => {
        // Pastikan user yang ditambahkan adalah versi terbaru dari state users
        const updatedUser = users.find(u => u.id === user.id) || user;
        return [...prev, updatedUser];
      });
    } else {
      setSelectedUsers(prev => prev.filter(u => u.id !== user.id));
    }
  };

  const isAllSelected = users.length > 0 && selectedUsers.length === users.length;
  const isIndeterminate = selectedUsers.length > 0 && selectedUsers.length < users.length;

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
          checked={selectedUsers.some(u => u.id === params.row.id)}
          onChange={(e) => handleUserSelection(params.row, e.target.checked)}
        />
      ),
    },
    {
      field: 'email',
      headerName: 'Email',
      flex: 2,
      renderCell: (params) => (
        <Typography variant="body2" fontWeight="medium">
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'domain_name',
      headerName: 'Domain',
      flex: 1,
      renderCell: (params) => (
        <Chip
          label={params.value}
          size="small"
          variant="outlined"
          color="primary"
        />
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 100,
      renderCell: (params) => (
        <Chip
          label={params.value}
          size="small"
          color={params.value === 'active' ? 'success' : 'default'}
        />
      ),
    },
    {
      field: 'connection_status',
      headerName: 'IMAP Status',
      width: 140,
      renderCell: (params) => {
        const connection = params.row.connection;
        const statusText = getConnectionStatusText(connection);

        return (
          <Tooltip title={connection?.message || statusText}>
            <Chip
              icon={getConnectionStatusIcon(connection)}
              label={statusText}
              size="small"
              color={getConnectionStatusColor(connection)}
              variant="outlined"
            />
          </Tooltip>
        );
      },
    },
    {
      field: 'email_count',
      headerName: 'Emails',
      width: 80,
      align: 'right',
      valueFormatter: (params) => params.value?.toLocaleString() || 0,
    },
    {
      field: 'total_size',
      headerName: 'Storage',
      width: 100,
      align: 'right',
      valueFormatter: (params) => {
        const size = params.value || 0;
        if (size === 0) return '0 B';
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
      },
    },
    {
      field: 'last_email_date',
      headerName: 'Last Email',
      width: 120,
      valueFormatter: (params) => {
        if (!params.value) return 'Never';
        return new Date(params.value).toLocaleDateString();
      },
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 250,
      sortable: false,
      renderCell: (params) => {
        const user = params.row;
        const connection = user.connection;

        return (
          <Box>
            <Tooltip title="View Details">
              <IconButton
                size="small"
                onClick={() => handleViewUser(user)}
                color="info"
              >
                <Person />
              </IconButton>
            </Tooltip>

            <Tooltip title={user.status === 'active' ? 'Deactivate' : 'Activate'}>
              <Switch
                size="small"
                checked={user.status === 'active'}
                onChange={(e) => handleStatusChange(user, e.target.checked ? 'active' : 'inactive')}
                color="primary"
              />
            </Tooltip>

            {user.status === 'active' && (
              <>
                {(!connection || connection.status === 'disconnected') ? (
                  <Tooltip title="Start IMAP Connection">
                    <IconButton
                      size="small"
                      onClick={() => handleConnect(user)}
                      color="success"
                    >
                      <PlayArrow />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <Tooltip title="Stop IMAP Connection">
                    <IconButton
                      size="small"
                      onClick={() => handleDisconnect(user)}
                      color="warning"
                    >
                      <Stop />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}

            <Tooltip title="Run Manual Backup">
              <IconButton
                size="small"
                onClick={() => handleManualBackup(user)}
                color="info"
                disabled={user.status !== 'active'}
              >
                <Sync />
              </IconButton>
            </Tooltip>

            <Tooltip title="Delete User">
              <IconButton
                size="small"
                onClick={() => handleDeleteUser(user)}
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
          Users Management
        </Typography>
        <Button
          variant="outlined"
          startIcon={<Refresh />}
          onClick={loadUsers}
        >
          Refresh
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Filters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Filters
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="Search Email"
                value={filters.search}
                onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
                placeholder="Search by email..."
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <FormControl fullWidth>
                <InputLabel>Domain</InputLabel>
                <Select
                  value={filters.domain_id}
                  onChange={(e) => setFilters(prev => ({ ...prev, domain_id: e.target.value }))}
                  label="Domain"
                >
                  <MenuItem value="">
                    <em>All Domains</em>
                  </MenuItem>
                  {domains.map((domain) => (
                    <MenuItem key={domain.id} value={domain.id}>
                      {domain.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={3}>
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
                  <MenuItem value="active">Active</MenuItem>
                  <MenuItem value="inactive">Inactive</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={3}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => {
                  setFilters({ domain_id: '', status: '', search: '' });
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
              >
                Clear Filters
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardContent>
          {loading ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : (
            <>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Box display="flex" alignItems="center" gap={2}>
                  <Typography variant="h6">
                    Users ({pagination.total.toLocaleString()})
                  </Typography>
                  {selectedUsers.length > 0 && (
                    <Chip
                      label={`${selectedUsers.length} selected`}
                      color="primary"
                      size="small"
                      onDelete={() => setSelectedUsers([])}
                    />
                  )}
                </Box>
                <Box display="flex" alignItems="center" gap={2}>
                  <Typography variant="body2" color="text.secondary">
                    Page {pagination.page} of {pagination.pages}
                  </Typography>
                  {selectedUsers.length > 0 && (
                    <Box display="flex" gap={1} sx={{ flexWrap: 'wrap' }}>
                      <Button
                        variant="contained"
                        color="success"
                        startIcon={bulkImapLoading ? <CircularProgress size={16} /> : <PlayCircle />}
                        onClick={handleBulkImapStart}
                        disabled={bulkImapLoading}
                        size="small"
                        sx={{ minWidth: '180px' }}
                      >
                        {bulkImapLoading ? (bulkImapResults?.currentUser ? `Processing: ${bulkImapResults.currentUser}` : 'Starting...') : `Start Sequential IMAP (${selectedUsers.length})`}
                      </Button>
                      <Button
                        variant="outlined"
                        color="warning"
                        startIcon={bulkDisconnectLoading ? <CircularProgress size={16} /> : <Stop />}
                        onClick={handleBulkImapDisconnect}
                        disabled={bulkDisconnectLoading}
                        size="small"
                      >
                        {bulkDisconnectLoading ? 'Stopping...' : `Stop IMAP (${selectedUsers.length})`}
                      </Button>
                      <Button
                        variant="contained"
                        color="error"
                        startIcon={bulkDeleteLoading ? <CircularProgress size={16} /> : <DeleteSweep />}
                        onClick={handleBulkDeleteUsers}
                        disabled={bulkDeleteLoading}
                        size="small"
                      >
                        {bulkDeleteLoading ? 'Deleting...' : `Delete Users (${selectedUsers.length})`}
                      </Button>
                    </Box>
                  )}

                  {selectedUsers.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                      Select users above to access bulk operations
                    </Typography>
                  )}
                </Box>
              </Box>

              <DataGrid
                rows={users}
                columns={columns}
                pageSize={pagination.limit}
                rowsPerPageOptions={[10, 25, 50, 100]}
                autoHeight
                disableSelectionOnClick
                pagination
                paginationMode="server"
                rowCount={pagination.total}
                page={pagination.page - 1}
                onPageChange={(page) => setPagination(prev => ({ ...prev, page: page + 1 }))}
                onPageSizeChange={(pageSize) => setPagination(prev => ({ ...prev, limit: pageSize, page: 1 }))}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* User Detail Dialog */}
      <Dialog
        open={userDialog.open}
        onClose={() => setUserDialog({ open: false, user: null, stats: null, loading: false })}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          User Details: {userDialog.user?.email}
        </DialogTitle>
        <DialogContent>
          {userDialog.loading ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : userDialog.user && userDialog.stats ? (
            <Box>
              <Grid container spacing={3}>
                <Grid item xs={12} md={6}>
                  <Paper sx={{ p: 2 }}>
                    <Typography variant="h6" gutterBottom>
                      User Information
                    </Typography>
                    <Typography><strong>Email:</strong> {userDialog.user.email}</Typography>
                    <Typography><strong>Domain:</strong> {userDialog.user.domain_name}</Typography>
                    <Typography><strong>Status:</strong>
                      <Chip
                        label={userDialog.user.status}
                        size="small"
                        color={userDialog.user.status === 'active' ? 'success' : 'default'}
                        sx={{ ml: 1 }}
                      />
                    </Typography>
                    <Typography><strong>Created:</strong> {new Date(userDialog.user.created_at).toLocaleString()}</Typography>
                  </Paper>
                </Grid>

                <Grid item xs={12} md={6}>
                  <Paper sx={{ p: 2 }}>
                    <Typography variant="h6" gutterBottom>
                      Email Statistics
                    </Typography>
                    <Typography><strong>Total Emails:</strong> {userDialog.stats.stats?.total_emails?.toLocaleString() || 0}</Typography>
                    <Typography><strong>Total Size:</strong> {
                      userDialog.stats.stats?.total_size ?
                        `${(userDialog.stats.stats.total_size / (1024 * 1024)).toFixed(1)} MB` :
                        '0 MB'
                    }</Typography>
                    <Typography><strong>Last Email:</strong> {
                      userDialog.stats.stats?.last_email_date ?
                        new Date(userDialog.stats.stats.last_email_date).toLocaleString() :
                        'Never'
                    }</Typography>
                  </Paper>
                </Grid>

                {userDialog.stats.daily && userDialog.stats.daily.length > 0 && (
                  <Grid item xs={12}>
                    <Paper sx={{ p: 2 }}>
                      <Typography variant="h6" gutterBottom>
                        Recent Email Activity (Last 30 days)
                      </Typography>
                      <Box sx={{ maxHeight: 200, overflow: 'auto' }}>
                        {userDialog.stats.daily.map((day, index) => (
                          <Box key={index} display="flex" justifyContent="space-between" py={0.5}>
                            <Typography variant="body2">
                              {new Date(day.date).toLocaleDateString()}
                            </Typography>
                            <Typography variant="body2">
                              {day.count} emails ({day.size ? (day.size / 1024).toFixed(0) : 0} KB)
                            </Typography>
                          </Box>
                        ))}
                      </Box>
                    </Paper>
                  </Grid>
                )}
              </Grid>
            </Box>
          ) : (
            <Alert severity="error">
              Failed to load user details
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setUserDialog({ open: false, user: null, stats: null, loading: false })}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk IMAP Results Dialog */}
      <Dialog
        open={bulkImapResults !== null}
        onClose={() => setBulkImapResults(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <PlayCircle />
            Bulk IMAP Connection Results
          </Box>
        </DialogTitle>
        <DialogContent>
          {bulkImapResults && (
            <Box>
              {/* Summary */}
              <Box display="flex" gap={2} mb={3}>
                <Chip
                  label={`Total: ${bulkImapResults.total}`}
                  color="primary"
                  size="small"
                />
                <Chip
                  icon={<CheckCircle />}
                  label={`Success: ${bulkImapResults.success}`}
                  color="success"
                  size="small"
                />
                {bulkImapResults.skipped > 0 && (
                  <Chip
                    label={`Skipped: ${bulkImapResults.skipped}`}
                    color="info"
                    size="small"
                  />
                )}
                {bulkImapResults.error > 0 && (
                  <Chip
                    icon={<Error />}
                    label={`Failed: ${bulkImapResults.error}`}
                    color="error"
                    size="small"
                  />
                )}
              </Box>

              {/* Detailed Results */}
              <Paper sx={{ maxHeight: 400, overflow: 'auto' }}>
                <Box sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Operation Details
                  </Typography>
                  {bulkImapResults.results.map((result, index) => {
                    const getBgColor = (status) => {
                      switch (status) {
                        case 'success': return '#e8f5e8';
                        case 'skipped': return '#e3f2fd';
                        case 'error': return '#ffebee';
                        default: return '#f5f5f5';
                      }
                    };

                    const getIcon = (status) => {
                      switch (status) {
                        case 'success': return <CheckCircle color="success" fontSize="small" />;
                        case 'skipped': return <CheckCircle color="info" fontSize="small" />;
                        case 'error': return <Error color="error" fontSize="small" />;
                        default: return null;
                      }
                    };

                    return (
                      <Box key={index} sx={{ mb: 1, p: 1, borderRadius: 1, bgcolor: getBgColor(result.status) }}>
                        <Box display="flex" alignItems="center" gap={1}>
                          {getIcon(result.status)}
                          <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                            {result.user}
                          </Typography>
                        </Box>
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
                          {result.message}
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>
              </Paper>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkImapResults(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk Disconnect Results Dialog */}
      <Dialog
        open={bulkDisconnectResults !== null}
        onClose={() => setBulkDisconnectResults(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <Stop />
            Bulk IMAP Disconnect Results
          </Box>
        </DialogTitle>
        <DialogContent>
          {bulkDisconnectResults && (
            <Box>
              {/* Summary */}
              <Box display="flex" gap={2} mb={3}>
                <Chip
                  label={`Total: ${bulkDisconnectResults.total}`}
                  color="primary"
                  size="small"
                />
                <Chip
                  icon={<CheckCircle />}
                  label={`Success: ${bulkDisconnectResults.success}`}
                  color="success"
                  size="small"
                />
                {bulkDisconnectResults.error > 0 && (
                  <Chip
                    icon={<Error />}
                    label={`Failed: ${bulkDisconnectResults.error}`}
                    color="error"
                    size="small"
                  />
                )}
              </Box>

              {/* Detailed Results */}
              <Paper sx={{ maxHeight: 400, overflow: 'auto' }}>
                <Box sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Operation Details
                  </Typography>
                  {bulkDisconnectResults.results.map((result, index) => (
                    <Box key={index} sx={{ mb: 1, p: 1, borderRadius: 1, bgcolor: result.status === 'success' ? '#e8f5e8' : '#ffebee' }}>
                      <Box display="flex" alignItems="center" gap={1}>
                        {result.status === 'success' ? (
                          <CheckCircle color="success" fontSize="small" />
                        ) : (
                          <Error color="error" fontSize="small" />
                        )}
                        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                          {result.user}
                        </Typography>
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
                        {result.message}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Paper>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkDisconnectResults(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk Delete Results Dialog */}
      <Dialog
        open={bulkDeleteResults !== null}
        onClose={() => setBulkDeleteResults(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <DeleteSweep />
            Bulk User Deletion Results
          </Box>
        </DialogTitle>
        <DialogContent>
          {bulkDeleteResults && (
            <Box>
              {/* Summary */}
              <Box display="flex" gap={2} mb={3}>
                <Chip
                  label={`Total: ${bulkDeleteResults.total}`}
                  color="primary"
                  size="small"
                />
                <Chip
                  icon={<CheckCircle />}
                  label={`Success: ${bulkDeleteResults.success}`}
                  color="success"
                  size="small"
                />
                {bulkDeleteResults.error > 0 && (
                  <Chip
                    icon={<Error />}
                    label={`Failed: ${bulkDeleteResults.error}`}
                    color="error"
                    size="small"
                  />
                )}
              </Box>

              {/* Warning for successful deletions */}
              {bulkDeleteResults.success > 0 && (
                <Alert severity="warning" sx={{ mb: 3 }}>
                  ⚠️ {bulkDeleteResults.success} user(s) and all their associated data (emails, attachments, history) have been permanently deleted.
                </Alert>
              )}

              {/* Detailed Results */}
              <Paper sx={{ maxHeight: 400, overflow: 'auto' }}>
                <Box sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>
                    Operation Details
                  </Typography>
                  {bulkDeleteResults.results.map((result, index) => (
                    <Box key={index} sx={{ mb: 1, p: 1, borderRadius: 1, bgcolor: result.status === 'success' ? '#e8f5e8' : '#ffebee' }}>
                      <Box display="flex" alignItems="center" gap={1}>
                        {result.status === 'success' ? (
                          <CheckCircle color="success" fontSize="small" />
                        ) : (
                          <Error color="error" fontSize="small" />
                        )}
                        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                          {result.user}
                        </Typography>
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
                        {result.message}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Paper>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkDeleteResults(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Manual Backup Progress Dialog */}
      <Dialog
        open={manualBackupProgress !== null}
        onClose={() => setManualBackupProgress(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <Sync />
            Manual Backup Progress
          </Box>
        </DialogTitle>
        <DialogContent>
          {manualBackupProgress && (
            <Box textAlign="center" py={2}>
              <Typography variant="h6" gutterBottom>
                {manualBackupProgress.user.email}
              </Typography>

              <Box my={3}>
                {manualBackupProgress.status === 'running' ? (
                  <CircularProgress size={60} />
                ) : manualBackupProgress.status === 'completed' ? (
                  <CheckCircle color="success" sx={{ fontSize: 60 }} />
                ) : manualBackupProgress.status === 'failed' ? (
                  <Error color="error" sx={{ fontSize: 60 }} />
                ) : (
                  <Sync color="info" sx={{ fontSize: 60 }} />
                )}
              </Box>

              <Typography variant="body1" gutterBottom>
                {manualBackupProgress.message}
              </Typography>

              {manualBackupProgress.progress && (
                <Typography variant="body2" color="text.secondary">
                  {manualBackupProgress.progress}
                </Typography>
              )}

              {manualBackupProgress.lastActivity && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  Last activity: {new Date(manualBackupProgress.lastActivity).toLocaleString()}
                </Typography>
              )}

              <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                Started: {new Date(manualBackupProgress.startTime).toLocaleString()}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManualBackupProgress(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk IMAP Progress Dialog */}
      <Dialog
        open={bulkImapProgress !== null}
        onClose={() => setBulkImapProgress(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" gap={1}>
            <PlayCircle />
            Bulk IMAP Processing Progress
          </Box>
        </DialogTitle>
        <DialogContent>
          {bulkImapProgress && (
            <Box textAlign="center" py={2}>
              <Typography variant="h6" gutterBottom>
                Sequential IMAP Connection Setup
              </Typography>

              <Typography variant="body1" gutterBottom sx={{ mt: 2 }}>
                Processing user {bulkImapProgress.currentUserIndex + 1} of {bulkImapProgress.totalUsers}
              </Typography>

              <Typography variant="h5" color="primary" sx={{ fontWeight: 'bold', mt: 1 }}>
                {bulkImapProgress.user?.email}
              </Typography>

              <Box my={3}>
                <CircularProgress size={60} />
              </Box>

              <Typography variant="body1" gutterBottom>
                {bulkImapProgress.message}
              </Typography>

              {/* Progress Summary */}
              <Box sx={{ mt: 3, p: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Overall Progress
                </Typography>
                <Box display="flex" justifyContent="center" gap={2} flexWrap="wrap">
                  <Chip
                    label={`Processed: ${bulkImapProgress.currentUserIndex}`}
                    color="primary"
                    size="small"
                  />
                  <Chip
                    label={`Remaining: ${bulkImapProgress.totalUsers - bulkImapProgress.currentUserIndex}`}
                    color="default"
                    size="small"
                  />
                  <Chip
                    label={`Total: ${bulkImapProgress.totalUsers}`}
                    color="info"
                    size="small"
                  />
                </Box>
              </Box>

              {/* Current Results */}
              {bulkImapProgress.results && bulkImapProgress.results.length > 0 && (
                <Box sx={{ mt: 3, maxHeight: 200, overflow: 'auto' }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Completed Users
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {bulkImapProgress.results.map((result, index) => {
                      const getBgColor = (status) => {
                        switch (status) {
                          case 'success': return '#e8f5e8';
                          case 'skipped': return '#e3f2fd';
                          case 'error': return '#ffebee';
                          default: return '#f5f5f5';
                        }
                      };

                      const getIcon = (status) => {
                        switch (status) {
                          case 'success': return <CheckCircle color="success" fontSize="small" />;
                          case 'skipped': return <CheckCircle color="info" fontSize="small" />;
                          case 'error': return <Error color="error" fontSize="small" />;
                          default: return null;
                        }
                      };

                      return (
                        <Box key={index} sx={{ p: 1, borderRadius: 1, bgcolor: getBgColor(result.status) }}>
                          <Box display="flex" alignItems="center" gap={1}>
                            {getIcon(result.status)}
                            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                              {result.user}
                            </Typography>
                          </Box>
                          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
                            {result.message}
                          </Typography>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              )}

              <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                Started: {new Date(bulkImapProgress.startTime).toLocaleString()}
              </Typography>

              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                This dialog will close automatically when processing is complete.
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkImapProgress(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Users;
