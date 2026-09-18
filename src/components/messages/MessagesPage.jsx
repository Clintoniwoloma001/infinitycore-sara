import React, { useEffect, useMemo, useState } from 'react'
import { AtSign, Bookmark, Hash, Landmark, MessageSquare, Users } from 'lucide-react'
import { supabase } from '../../supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { getUnreadMessageCounts, unreadMessageTotal } from '../../services/corporateChatService'
import DirectTab from './DirectTab'
import Conversations from './Conversations'
import AnnouncementsTab from './AnnouncementsTab'
import SavedTab from './SavedTab'

const TABS = [
  { key: 'direct', label: 'Direct', icon: MessageSquare },
  { key: 'groups', label: 'Groups', icon: Users },
  { key: 'channels', label: 'Channels', icon: Hash },
  { key: 'announcements', label: 'Announcements', icon: Landmark },
  { key: 'saved', label: 'Saved', icon: Bookmark },
  { key: 'mentions', label: 'Mentions', icon: AtSign },
]

const realPersonName = (person) => {
  if (person?.full_name && (!person.email || String(person.full_name).toLowerCase() !== String(person.email).toLowerCase())) {
    return person.full_name
  }
  return 'Unknown User'
}

export default function MessagesPage() {
  const { user, profile } = useAuth()
  const me = user?.id
  const myName = realPersonName({ full_name: profile?.full_name, email: user?.email })

  const [tab, setTab] = useState('direct')
  const [people, setPeople] = useState([])
  const [identity, setIdentity] = useState({})
  const [loading, setLoading] = useState(true)
  const [directUnread, setDirectUnread] = useState(0)

  // Directory for pickers: staff across the platform (including me).
  // Sourced from the get_messaging_directory RPC — profiles/employees are
  // RLS-restricted to admins, so a plain profiles query returns nothing
  // for regular staff (empty New Message / New Group pickers).
  useEffect(() => {
    if (!me) return
    setLoading(true)
    const indexDirectory = (rows) => {
      const list = (rows || []).map((p) => ({
        id: p.user_id,
        user_id: p.user_id,
        full_name: realPersonName(p),
        email: p.email,
        role: p.role,
        department: p.department,
        position: p.position,
        employment_status: p.employment_status,
        is_former_employee: p.is_former_employee,
        profile_status: p.profile_status,
      }))
      const identityMap = {}
      for (const p of rows || []) {
        if (!p.user_id) continue
        identityMap[p.user_id] = {
          userId: p.user_id,
          name: realPersonName(p),
          email: p.email,
          role: p.role,
          department: p.department,
          position: p.position,
        }
      }
      // always include myself so the picker shows the whole platform
      identityMap[me] = identityMap[me] || {
        userId: me, name: myName, email: user?.email, role: profile?.role, department: profile?.department,
      }
      return { list, identityMap }
    }
    const loadLegacy = async () => {
      // Pre-migration fallback (phase 40 RPC missing): admins/HR see the
      // full profiles list; regular staff see only themselves.
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, department, position, status')
        .neq('role', 'customer')
        .order('full_name', { ascending: true })
      const rows = (data || []).map((p) => ({ ...p, user_id: p.id }))
      rows.push({ user_id: me, full_name: myName, email: user?.email, role: profile?.role, department: profile?.department })
      const { list, identityMap } = indexDirectory(rows)
      setPeople(list)
      setIdentity(identityMap)
    }
    supabase
      .rpc('get_messaging_directory', { p_search: null })
      .then(async ({ data, error }) => {
        if (error || !Array.isArray(data)) {
          await loadLegacy()
          return
        }
        const { list, identityMap } = indexDirectory(data)
        setPeople(list)
        setIdentity(identityMap)
      })
      .catch(async () => {
        await loadLegacy()
      })
      .finally(() => setLoading(false))
  }, [me])

  useEffect(() => {
    if (!me) return
    let active = true
    const refreshUnread = async () => {
      try {
        const payload = await getUnreadMessageCounts()
        if (active) setDirectUnread(unreadMessageTotal(payload))
      } catch (_) {}
    }
    refreshUnread()
    const timer = window.setInterval(refreshUnread, 60000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [me])

  // Support deep links like /chat?tab=announcements (used by notifications).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const t = qs.get('tab')
    if (t && TABS.some((x) => x.key === t)) setTab(t)
  }, [])

  const setTabAndDeepLink = (key) => {
    setTab(key)
    const base = window.location.hash.split('?')[0]
    window.history.replaceState(null, '', `${base}?tab=${key}`)
  }

  const activeTab = useMemo(() => TABS.find((t) => t.key === tab) || TABS[0], [tab])

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Messages</h2>
        <p className="text-sm text-slate-500 mt-1">
          Corporate communication — direct messages, team groups, organizational channels and official announcements.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5 bg-white border border-slate-200 rounded-xl p-1.5 w-fit">
        {TABS.map((t) => {
          const Icon = t.icon
          const on = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTabAndDeepLink(t.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                on ? 'bg-[#009944] text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
              {t.key === 'direct' && directUnread > 0 && (
                <span className="min-w-[18px] h-[18px] rounded-full bg-white/20 px-1.5 text-center text-[10px] font-semibold leading-[18px]">{directUnread > 99 ? '99+' : directUnread}</span>
              )}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-400">
          Loading your messages…
        </div>
      ) : (
        <>
          {activeTab.key === 'direct' && <DirectTab people={people} identity={identity} onUnreadChange={setDirectUnread} />}
          {activeTab.key === 'groups' && <Conversations kind="group" people={people} identity={identity} />}
          {activeTab.key === 'channels' && <Conversations kind="channel" people={people} identity={identity} />}
          {activeTab.key === 'announcements' && <AnnouncementsTab people={people} identity={identity} />}
          {(activeTab.key === 'saved' || activeTab.key === 'mentions') && <SavedTab identity={identity} />}
        </>
      )}
    </div>
  )
}
