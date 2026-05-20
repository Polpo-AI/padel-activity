import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import AdminApp from './admin/AdminApp.jsx'
import { ThemeProvider } from './shared/ThemeContext.jsx'

const isAdmin = window.location.pathname.startsWith('/admin')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      {isAdmin ? <AdminApp /> : <App />}
    </ThemeProvider>
  </React.StrictMode>,
)
