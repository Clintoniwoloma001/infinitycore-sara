import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { envMissing } from './supabaseClient'
import './index.css'

function ConfigError() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4">
      <div className="max-w-md text-center">
        <h1 className="text-white text-xl font-semibold mb-2">Authentication system not initialized</h1>
        <p className="text-white/60 text-sm">
          Please check configuration. Create a <code className="text-white/80">.env</code> file with
          <code className="text-white/80"> VITE_SUPABASE_URL</code> and
          <code className="text-white/80"> VITE_SUPABASE_ANON_KEY</code>.
        </p>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>{envMissing ? <ConfigError /> : <App />}</React.StrictMode>
)