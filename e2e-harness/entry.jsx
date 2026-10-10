import React from 'react'
import { createRoot } from 'react-dom/client'
import LivePositions from './LivePositions'
import './style.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LivePositions />
  </React.StrictMode>,
)
