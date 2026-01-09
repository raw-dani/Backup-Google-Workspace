import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Domains from './pages/Domains';
import Users from './pages/Users';
import Emails from './pages/Emails';
import Exports from './pages/Exports';
import BackupSettings from './pages/BackupSettings';
import AdminManagement from './pages/AdminManagement';
import Layout from './components/Layout';
import { api } from './services/api';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        // Set token in axios headers
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        // Verify token with backend
        const response = await api.get('/auth/me');
        setUser(response.data.user);
      } catch (error) {
        // Token invalid, clear it
        localStorage.removeItem('token');
        delete api.defaults.headers.common['Authorization'];
      }
    }
    setLoading(false);
  };

  const handleLogin = (userData, token) => {
    setUser(userData);
    localStorage.setItem('token', token);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    navigate('/dashboard');
  };

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    }

    setUser(null);
    localStorage.removeItem('token');
    delete api.defaults.headers.common['Authorization'];
    navigate('/login');
  };

  if (loading) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        minHeight="100vh"
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          user ? <Navigate to="/dashboard" replace /> : <Login onLogin={handleLogin} />
        }
      />
      <Route
        path="/"
        element={
          user ? (
            <Layout user={user} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="domains" element={<Domains />} />
        <Route path="users" element={<Users />} />
        <Route path="emails" element={<Emails />} />
        <Route path="exports" element={<Exports />} />
        <Route path="backup-settings" element={<BackupSettings />} />
        <Route path="admin-management" element={<AdminManagement />} />
      </Route>
    </Routes>
  );
}

export default App;
