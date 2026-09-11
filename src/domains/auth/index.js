// AUTH domain — session/identity + role/permission definitions.
// UI must go through the useAuth hook, not supabaseClient directly.
export { useAuth, AuthProvider } from '../../hooks/useAuth'
export { PERMISSIONS } from '../../constants/permissions'
export * as roles from '../../constants/roles'
