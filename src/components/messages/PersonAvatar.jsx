import React, { useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { displayPersonName, hueFor, initials } from './personUtils'

export default function PersonAvatar({ person, sizeClass = 'w-9 h-9', textClass = 'text-xs' }) {
  const [url, setUrl] = useState(null)
  const name = displayPersonName(person)
  const path = person?.profilePicturePath || person?.profile_picture_path || person?.avatar_url

  useEffect(() => {
    let mounted = true
    if (!path) {
      setUrl(null)
      return
    }
    supabase.storage
      .from('documents')
      .createSignedUrl(path, 3600)
      .then(({ data, error }) => {
        if (mounted && !error && data?.signedUrl) setUrl(data.signedUrl)
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [path])

  return (
    <div className={`${sizeClass} rounded-full flex items-center justify-center font-semibold text-white shrink-0 overflow-hidden ${url ? '' : hueFor(name)} ${textClass}`}>
      {url ? (
        <img src={url} alt={name} className="w-full h-full object-cover" />
      ) : (
        initials(name)
      )}
    </div>
  )
}
