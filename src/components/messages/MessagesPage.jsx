import React, { useEffect, useMemo, useState } from 'react'
import { AtSign, Bookmark, Hash, Landmark, Loader2, MessageSquare, Search, Users, X } from 'lucide-react'
import { supabase } from '../../supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { getUnreadMessageCounts, unreadMessageTotal, getInviteContext, joinViaInvite } from '../../services/corporateChatService'
import DirectTab from './DirectTab'
import Conversations from './Conversations'
import AnnouncementsTab from './AnnouncementsTab'
import SavedTab from './SavedTab'
import { displayPersonName } from './personUtils'

const TABS = [
  { key: 'direct', label: 'Direct', icon: MessageSquare },
  { key: 'groups', label: 'Groups', icon: Users },
  { key: 'channels', label: 'Channels', icon: Hash },
  { key: 'announcements', label: 'Announcements', icon: Landmark },
  { key: 'saved', label: 'Saved', icon: Bookmark },
  { key: 'mentions', label: 'Mentions', icon: AtSign },
]

const realPersonName = (person) => displayPersonName(person)

// Search is scoped to the active tab, and the placeholder states that scope so
// a user never wonders why a channel name finds nothing in the people list.
const SEARCH_PLACEHOLDER = {
  direct: 'Search people…',
  groups: 'Search groups…',
  channels: 'Search channels…',
  announcements: 'Search announcements…',
  saved: 'Search saved messages…',
  mentions: 'Search mentions…',
}

function MessageSearchBar({ tabKey, value, onChange }) {
  const placeholder = SEARCH_PLACEHOLDER[tabKey]
  if (!placeholder) return null
  return (
    <div className="relative mb-3">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full pl-9 pr-9 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#009944]/30 focus:border-[#009944]"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-slate-100"
        >
          <X className="w-3.5 h-3.5 text-slate-400" />
        </button>
      )}
    </div>
  )
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
  const [inviteCtx, setInviteCtx] = useState(null)
  const [inviteError, setInviteError] = useState('')
  const [joiningInvite, setJoiningInvite] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [pendingDmThreadId, setPendingDmThreadId] = useState(null)
  // Search is scoped to the ACTIVE tab. Held here rather than inside each tab
  // so switching tabs can clear it explicitly, which stops a channel query
  // from silently filtering the people list and vice versa.
  const [search, setSearch] = useState('')

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
        has_account: p.has_account !== undefined ? !!p.has_account : true,
      }))
      const identityMap = {}
      for (const p of rows || []) {
        if (!p.user_id) continue
        identityMap[p.user_id] = {
          userId: p.user_id,
          employeeId: p.employee_id,
          name: realPersonName(p),
          email: p.email,
          role: p.role,
          department: p.department,
          position: p.position,
          staffId: p.staff_id,
          employmentStatus: p.employment_status,
          branch: p.branch,
          profileStatus: p.profile_status,
          profilePicturePath: p.profile_picture_path,
          isFormerEmployee: p.is_former_employee,
          hasAccount: p.has_account !== undefined ? !!p.has_account : true,
        }
      }
      // always include myself so the picker shows the whole platform
      identityMap[me] = identityMap[me] || {
        userId: me,
        name: myName,
        email: user?.email,
        role: profile?.role,
        department: profile?.department,
        position: profile?.designation,
        staffId: profile?.employee_number,
        employmentStatus: profile?.status,
        branch: profile?.branch,
        profileStatus: profile?.status,
        hasAccount: true,
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

  // Support deep links like /chat?tab=announcements (notifications) and
  // /chat?invite=TOKEN (shareable channel/group invite links).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const t = qs.get('tab')
    if (t && TABS.some((x) => x.key === t)) setTab(t)
    const invite = qs.get('invite')
    if (invite) {
      getInviteContext(invite)
        .then((ctx) => { if (ctx?.ok) setInviteCtx({ token: invite, ...ctx }) })
        .catch(() => {})
    }
  }, [])

  const setTabAndDeepLink = (key) => {
    setTab(key)
    // Clear the previous tab's query. A channel name left in the box would
    // filter the people list to nothing, which reads as a broken search rather
    // than a stale query.
    setSearch('')
    const base = window.location.hash.split('?')[0]
    window.history.replaceState(null, '', `${base}?tab=${key}`)
  }

  const openInviteTarget = () => {
    const targetTab = inviteCtx?.scope === 'group' ? 'groups' : 'channels'
    setInviteCtx(null)
    setTab(targetTab)
    setReloadTick((t) => t + 1)
    const base = window.location.hash.split('?')[0]
    window.history.replaceState(null, '', `${base}?tab=${targetTab}`)
  }

  const handleJoinInvite = async () => {
    if (!inviteCtx || joiningInvite) return
    setJoiningInvite(true)
    setInviteError('')
    try {
      const res = await joinViaInvite(inviteCtx.token)
      if (res?.ok) openInviteTarget()
      else setInviteError('This invite link could not be accepted.')
    } catch (e) {
      setInviteError(e?.message || 'Could not join via this link.')
    } finally {
      setJoiningInvite(false)
    }
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
          {/* Per-tab search: Direct searches people, Channels searches channels,
              Groups searches groups. The placeholder changes with the tab so
              the scope is never ambiguous. */}
          <MessageSearchBar tabKey={activeTab.key} value={search} onChange={setSearch} />
          {activeTab.key === 'direct' && <DirectTab people={people} identity={identity} onUnreadChange={setDirectUnread} openThreadId={pendingDmThreadId} onThreadOpened={() => setPendingDmThreadId(null)} search={search} />}
          {activeTab.key === 'groups' && (
            <Conversations
              key={`group-${reloadTick}`}
              kind="group"
              people={people}
              identity={identity}
              search={search}
              onSearchChange={setSearch}
              onStartDirectMessage={(threadId) => {
                setPendingDmThreadId(threadId)
                setTabAndDeepLink('direct')
              }}
            />
          )}
          {activeTab.key === 'channels' && (
            <Conversations
              key={`channel-${reloadTick}`}
              kind="channel"
              people={people}
              identity={identity}
              search={search}
              onSearchChange={setSearch}
              onStartDirectMessage={(threadId) => {
                setPendingDmThreadId(threadId)
                setTabAndDeepLink('direct')
              }}
            />
          )}
          {activeTab.key === 'announcements' && <AnnouncementsTab people={people} identity={identity} />}
          {(activeTab.key === 'saved' || activeTab.key === 'mentions') && <SavedTab identity={identity} />}
        </>
      )}

      {inviteCtx && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
                {inviteCtx.scope === 'group' ? <Users className="w-5 h-5 text-[#009944]" /> : <Hash className="w-5 h-5 text-[#009944]" />}
                {inviteCtx.scope === 'group' ? 'Group invite' : 'Channel invite'}
              </h3>
              <button onClick={() => setInviteCtx(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-base font-medium text-slate-800">{inviteCtx.context_name}</p>
            <p className="text-xs text-slate-500">
              {inviteCtx.member_count} member{inviteCtx.member_count === 1 ? '' : 's'} · {inviteCtx.scope}
              {inviteCtx.expires_at ? ` · open until ${new Date(inviteCtx.expires_at).toLocaleDateString()}` : ''}
            </p>
            {inviteCtx.already_member ? (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs text-emerald-700">
                You are already a member of this {inviteCtx.scope}.
              </div>
            ) : (
              <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5 text-xs text-slate-500">
                Accepting adds you to “{inviteCtx.context_name}” as a member. You can leave at any time.
              </div>
            )}
            {inviteError && <p className="text-xs text-rose-600">{inviteError}</p>}
            <div className="text-right space-x-2">
              <button onClick={() => setInviteCtx(null)} className="px-4 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">
                Close
              </button>
              {inviteCtx.already_member ? (
                <button onClick={openInviteTarget} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                  Open {inviteCtx.scope}
                </button>
              ) : (
                <button onClick={handleJoinInvite} disabled={joiningInvite} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
                  {joiningInvite && <Loader2 className="w-4 h-4 animate-spin" />} Join {inviteCtx.scope}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
