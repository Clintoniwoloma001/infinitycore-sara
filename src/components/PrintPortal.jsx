import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Renders children into a body-level container that is hidden on screen
// (.print-area-print) and becomes the only visible content when printing.
// Being outside any fixed overlay means multi-page A4 documents flow onto
// additional pages cleanly instead of being clipped to one printed sheet.
export default function PrintPortal({ children, className = '' }) {
  const hostRef = useRef(null)
  if (!hostRef.current) {
    const el = document.createElement('div')
    el.className = `print-area-print ${className}`.trim()
    hostRef.current = el
  }

  useEffect(() => {
    const node = hostRef.current
    document.body.appendChild(node)
    return () => {
      if (node.parentNode) node.parentNode.removeChild(node)
    }
  }, [])

  return createPortal(children, hostRef.current)
}