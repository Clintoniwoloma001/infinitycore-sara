import React from 'react'
import { useAuth } from '../hooks/useAuth'
import { ROLE_METADATA, ROLES } from '../constants/roles'
import { ChevronDown } from 'lucide-react'

/**
 * RoleSwitcher Component - Super Admin Feature
 * Allows Super Admin to view the application as different roles
 * This helps test different role experiences without switching accounts
 */
export default function RoleSwitcher() {
  const { canSwitchViews, viewingAsRole, setViewingAsRole, actualRole, availableModules } = useAuth()

  if (!canSwitchViews) return null

  // Roles available for Super Admin to view as
  const switchableRoles = [
    ROLES.SUPER_ADMIN,
    ROLES.ADMIN,
    ROLES.BRANCH_MANAGER,
    ROLES.AREA_MANAGER,
    ROLES.HEAD_OF_BUSINESS,
    ROLES.LOAN_OFFICER,
    ROLES.RELATIONSHIP_MANAGER,
    ROLES.CUSTOMER_SERVICE,
    ROLES.HR_MANAGER,
    ROLES.CUSTOMER,
  ]

  const currentViewRole = viewingAsRole || actualRole
  const currentViewMetadata = ROLE_METADATA[currentViewRole]

  return (
    <div className="bg-gradient-to-r from-purple-50 to-purple-100 border-2 border-purple-200 rounded-lg p-4 mb-6 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-semibold text-purple-600 uppercase tracking-wide">👁️ Super Admin View Mode</p>
          <p className="text-sm text-purple-700 mt-1">
            You are viewing as: <span className="font-bold text-purple-900">{currentViewMetadata?.label}</span>
          </p>
        </div>
        {viewingAsRole && (
          <button
            onClick={() => setViewingAsRole(null)}
            className="text-xs px-3 py-1 bg-purple-200 hover:bg-purple-300 text-purple-900 rounded-full font-medium transition"
          >
            Reset
          </button>
        )}
      </div>

      {/* Role Selector Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {switchableRoles.map((role) => {
          const metadata = ROLE_METADATA[role]
          const isSelected = currentViewRole === role
          const isActualRole = role === actualRole

          return (
            <button
              key={role}
              onClick={() => setViewingAsRole(isActualRole ? null : role)}
              className={`relative px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                isSelected
                  ? 'bg-white text-purple-900 shadow-md ring-2 ring-purple-400'
                  : 'bg-white/60 text-slate-700 hover:bg-white/80'
              }`}
              title={metadata?.description}
            >
              <span className="block truncate">{metadata?.label}</span>
              {isActualRole && <span className="text-[8px] text-purple-600 mt-0.5 block">YOUR ROLE</span>}
            </button>
          )
        })}
      </div>

      {/* Info message */}
      {viewingAsRole && (
        <div className="mt-3 p-2 bg-white/50 rounded text-xs text-purple-800">
          <strong>Info:</strong> You're viewing as {ROLE_METADATA[viewingAsRole]?.label}. This is a simulation.
          Actual permissions are still restricted by your Super Admin role in database.
        </div>
      )}
    </div>
  )
}
