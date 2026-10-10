import React from 'react'
import { createRoot } from 'react-dom/client'
import GeofenceMapEditor from './GeofenceEntry'
import './style.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GeofenceMapEditor
      branch={{ branchId: 'b1', branchName: 'Head Office', branchCode: 'BR-06' }}
      initial={{ lat: 6.605754, lng: 3.392573, radiusMeters: 150, locked: true }}
      onSave={() => {}}
      onCancel={() => {}}
    />
  </React.StrictMode>,
)
