# PHASE 1: IMPLEMENTATION PLAN
## Security Hardening + Foundation + Multi-Role Experience

**Duration**: 2-3 weeks
**Goal**: Build solid foundation with security hardening, role-aware routing, document management, task queue, and distinct customer/staff experiences.

---

## 📋 TABLE OF CONTENTS
1. [Database Schema Extensions](#database-schema-extensions)
2. [Security & RLS Hardening](#security--rls-hardening)
3. [Architecture Enhancements](#architecture-enhancements)
4. [Feature Implementation](#feature-implementation)
5. [Testing & Validation](#testing--validation)
6. [Deployment Checklist](#deployment-checklist)

---

## 1️⃣ DATABASE SCHEMA EXTENSIONS

### 1.1 Documents Table
```sql
-- Store uploaded files with metadata and verification status
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null, -- 'customer', 'loan_application', 'hr_candidate'
  entity_id uuid not null,
  document_type text not null, -- 'national_id', 'proof_of_address', 'employment_letter', 'cv', etc.
  file_name text not null,
  file_path text not null, -- Supabase storage path
  file_size int,
  mime_type text,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz default now(),
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  verification_status text default 'pending', -- 'pending', 'verified', 'rejected'
  verification_notes text,
  is_required boolean default false,
  created_at timestamptz default now()
);
```

### 1.2 Tasks / My Work Queue Table
```sql
-- Central task queue for all staff
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  task_type text not null, -- 'approval', 'verification', 'assessment', 'review', 'follow_up', 'support'
  entity_type text, -- 'loan_application', 'customer', 'document', 'support_case'
  entity_id uuid,
  assigned_to uuid references auth.users(id),
  created_by uuid references auth.users(id),
  priority text default 'normal', -- 'critical', 'high', 'normal', 'low'
  status text default 'pending', -- 'pending', 'in_progress', 'completed', 'cancelled'
  due_date date,
  completed_at timestamptz,
  completion_notes text,
  related_customer_id uuid references public.customers(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 1.3 Support Cases / Tickets Table
```sql
-- Customer support and internal case management
create table if not exists public.support_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text unique not null, -- e.g., 'CASE-2024-00001'
  customer_id uuid references public.customers(id),
  issue_category text not null, -- 'account', 'loan', 'payment', 'complaint', 'inquiry', 'other'
  issue_type text, -- Subcategory
  subject text not null,
  description text,
  created_by uuid references auth.users(id), -- Can be customer or staff
  assigned_to uuid references auth.users(id),
  status text default 'open', -- 'open', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed'
  priority text default 'normal',
  resolution text,
  closed_date timestamptz,
  sla_minutes int default 1440, -- Default 24 hours
  breached boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 1.4 HR Module Base Tables
```sql
-- Jobs and requisitions
create table if not exists public.hr_jobs (
  id uuid primary key default gen_random_uuid(),
  job_title text not null,
  department text,
  location text,
  employment_type text, -- 'full_time', 'part_time', 'contract'
  experience_years int,
  salary_min numeric,
  salary_max numeric,
  description text,
  requirements text,
  created_by uuid references auth.users(id),
  status text default 'draft', -- 'draft', 'published', 'closed'
  published_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz default now()
);

-- Candidate applications
create table if not exists public.hr_candidates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.hr_jobs(id),
  full_name text not null,
  email text,
  phone text,
  current_company text,
  years_experience int,
  cv_file_path text,
  cover_letter text,
  application_status text default 'received', -- 'received', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected'
  screening_score numeric,
  screening_notes text,
  screened_by uuid references auth.users(id),
  screened_at timestamptz,
  created_at timestamptz default now()
);

-- Assessments and tests
create table if not exists public.hr_assessments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id),
  assessment_type text, -- 'technical', 'behavioral', 'practical'
  test_name text,
  status text default 'pending', -- 'pending', 'in_progress', 'completed'
  score numeric,
  total_score numeric,
  notes text,
  completed_at timestamptz,
  created_at timestamptz default now()
);

-- Interviews
create table if not exists public.hr_interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id),
  scheduled_date timestamptz,
  interview_type text, -- 'phone', 'video', 'in_person'
  interviewer_id uuid references auth.users(id),
  feedback text,
  rating numeric,
  status text default 'scheduled', -- 'scheduled', 'completed', 'cancelled'
  created_at timestamptz default now()
);

-- Employees (hired candidates)
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  full_name text not null,
  email text,
  phone text,
  department text,
  position text,
  manager_id uuid references auth.users(id),
  hire_date date,
  employment_status text default 'active', -- 'active', 'on_leave', 'terminated'
  created_at timestamptz default now()
);
```

### 1.5 Role & Permissions Tables
```sql
-- Extended roles (instead of hardcoded text)
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  role_name text unique not null,
  display_name text,
  description text,
  is_system_role boolean default false, -- Can't be deleted
  created_at timestamptz default now()
);

-- Granular permissions
create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text unique not null, -- e.g., 'customers.read', 'loans.approve'
  description text,
  category text, -- 'customers', 'loans', 'hr', 'admin'
  created_at timestamptz default now()
);

-- Role-permission assignments
create table if not exists public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid references public.roles(id) on delete cascade,
  permission_id uuid references public.permissions(id) on delete cascade,
  created_at timestamptz default now(),
  unique(role_id, permission_id)
);
```

### 1.6 Configuration Table
```sql
-- System configuration (replaces hardcoded values)
create table if not exists public.system_config (
  id uuid primary key default gen_random_uuid(),
  config_key text unique not null,
  config_value text,
  config_type text, -- 'string', 'number', 'boolean', 'json'
  description text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

-- Insert default configs
insert into public.system_config (config_key, config_value, config_type, description)
values
  ('loan_default_interest_rate', '12', 'number', 'Default interest rate for loans'),
  ('loan_auto_approve_min_score', '75', 'number', 'Minimum risk score for auto-approval'),
  ('loan_manager_approve_min_score', '50', 'number', 'Minimum risk score for manager approval'),
  ('support_case_sla_minutes', '1440', 'number', 'Default SLA for support cases (minutes)'),
  ('document_max_size_mb', '10', 'number', 'Maximum document file size in MB')
on conflict do nothing;
```

---

## 2️⃣ SECURITY & RLS HARDENING

### 2.1 Enhanced RLS Policies

#### Customers: Department/Branch Isolation
```sql
-- Update customer RLS to respect department/relationship manager
create or replace policy "customers_read_authorized" on public.customers
  for select using (
    auth.uid() in (
      select id from auth.users
      where raw_user_meta_data->>'department' = (
        select department from public.customers where id = customers.id
      )
    )
    or public.current_role() = 'admin'
    or public.current_role() = 'relationship_manager'
  );
```

#### Documents: Strict Access Control
```sql
create policy "documents_read_own_entity" on public.documents
  for select using (
    public.current_role() = 'admin'
    or (entity_type = 'customer' and exists (
      select 1 from public.customers c 
      where c.id = entity_id and (
        c.created_by = auth.uid() 
        or auth.uid() in (select assigned_to from public.tasks where related_customer_id = c.id)
      )
    ))
  );

create policy "documents_insert_authorized" on public.documents
  for insert with check (
    public.current_role() != 'staff' 
    or (entity_type = 'customer' and auth.uid() in (
      select created_by from public.customers where id = entity_id
    ))
  );

create policy "documents_verify_authorized" on public.documents
  for update using (
    public.current_role() = 'admin'
    or public.current_role() = 'loan_officer'
  );
```

#### Tasks: Only Assigned or Admin
```sql
create policy "tasks_read_assigned" on public.tasks
  for select using (
    assigned_to = auth.uid() 
    or created_by = auth.uid() 
    or public.current_role() = 'admin'
  );

create policy "tasks_update_assigned" on public.tasks
  for update using (
    assigned_to = auth.uid() 
    or public.current_role() = 'admin'
  );
```

#### Support Cases: Role-Based Access
```sql
create policy "support_cases_read" on public.support_cases
  for select using (
    customer_id = (select id from public.customers where created_by = auth.uid())
    or assigned_to = auth.uid()
    or created_by = auth.uid()
    or public.current_role() in ('admin', 'manager', 'support_manager')
  );
```

#### HR: HR Staff Only
```sql
create policy "hr_jobs_read" on public.hr_jobs
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
    or status = 'published'
  );

create policy "hr_candidates_read" on public.hr_candidates
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );
```

### 2.2 Audit Logging Enhancement
```sql
-- Enhanced audit function that logs all changes
create or replace function public.audit_log(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_details jsonb
) returns void language sql security definer as $$
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    p_details,
    'info'
  );
$$;

-- Auto-log loan application changes
create or replace function public.log_loan_application_change()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    case when TG_OP = 'DELETE' then 'delete' else TG_OP end,
    'loan_application',
    (case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text,
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    jsonb_build_object(
      'old_status', OLD.status,
      'new_status', NEW.status,
      'old_risk_level', OLD.risk_level,
      'new_risk_level', NEW.risk_level,
      'amount', NEW.amount
    ),
    'info'
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists loan_application_audit on public.loan_applications;
create trigger loan_application_audit
  after insert or update or delete on public.loan_applications
  for each row execute function public.log_loan_application_change();
```

---

## 3️⃣ ARCHITECTURE ENHANCEMENTS

### 3.1 Extend Role System
**File**: `src/constants/roles.js`
```javascript
// Define all available roles with metadata
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  BRANCH_MANAGER: 'branch_manager',
  OPERATIONS_MANAGER: 'operations_manager',
  LOAN_OFFICER: 'loan_officer',
  RELATIONSHIP_MANAGER: 'relationship_manager',
  CUSTOMER_SERVICE: 'customer_service',
  HR_MANAGER: 'hr_manager',
  HR_OFFICER: 'hr_officer',
  STAFF: 'staff',
  CUSTOMER: 'customer',
};

export const ROLE_HIERARCHY = {
  [ROLES.SUPER_ADMIN]: 100,
  [ROLES.ADMIN]: 90,
  [ROLES.BRANCH_MANAGER]: 80,
  [ROLES.OPERATIONS_MANAGER]: 75,
  [ROLES.LOAN_OFFICER]: 60,
  [ROLES.RELATIONSHIP_MANAGER]: 60,
  [ROLES.HR_MANAGER]: 60,
  [ROLES.CUSTOMER_SERVICE]: 50,
  [ROLES.HR_OFFICER]: 50,
  [ROLES.STAFF]: 40,
  [ROLES.CUSTOMER]: 10,
};

export const ROLE_METADATA = {
  [ROLES.SUPER_ADMIN]: {
    label: 'Super Admin',
    description: 'Full system access, can switch all views',
    primaryModule: 'admin',
    color: '#7c3aed',
  },
  [ROLES.ADMIN]: {
    label: 'Admin',
    description: 'System administration and user management',
    primaryModule: 'admin',
    color: '#7c3aed',
  },
  [ROLES.LOAN_OFFICER]: {
    label: 'Loan Officer',
    description: 'Manage loan applications and assessments',
    primaryModule: 'loans',
    color: '#2563eb',
  },
  // ... etc for all roles
};
```

### 3.2 Permissions Service
**File**: `src/services/permissionsService.js`
```javascript
import { supabase } from '../supabaseClient'

export const permissionsService = {
  // Check if user has permission
  async hasPermission(userId, permissionKey) {
    const { data } = await supabase
      .from('role_permissions')
      .select('*')
      .eq('role_id', (
        await supabase
          .from('profiles')
          .select('role_id')
          .eq('id', userId)
          .single()
      ).data.role_id)
      .eq('permission_id', (
        await supabase
          .from('permissions')
          .select('id')
          .eq('permission_key', permissionKey)
          .single()
      ).data.id)
    return data && data.length > 0
  },

  // Get all permissions for user
  async getUserPermissions(userId) {
    const { data } = await supabase
      .rpc('get_user_permissions', { user_id: userId })
    return data || []
  },
}
```

### 3.3 Task Service
**File**: `src/services/taskService.js`
```javascript
import { supabase } from '../supabaseClient'

export const taskService = {
  async list(filters = {}) {
    let query = supabase.from('tasks').select('*')
    
    if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.priority) query = query.eq('priority', filters.priority)
    if (filters.entityType) query = query.eq('entity_type', filters.entityType)
    
    query = query.order('due_date', { ascending: true })
      .order('priority', { ascending: false })
    
    const { data, error } = await query
    if (error) throw error
    return data
  },

  async getById(id) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async create(task) {
    const { data, error } = await supabase
      .from('tasks')
      .insert([task])
      .select()
    if (error) throw error
    return data[0]
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
    if (error) throw error
    return data[0]
  },

  async complete(id, notes) {
    return this.update(id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      completion_notes: notes,
    })
  },
}
```

### 3.4 Document Service
**File**: `src/services/documentService.js`
```javascript
import { supabase } from '../supabaseClient'

export const documentService = {
  async upload(file, entityType, entityId, documentType) {
    // Upload to Supabase storage
    const fileName = `${entityType}/${entityId}/${Date.now()}-${file.name}`
    const { data, error: uploadError } = await supabase
      .storage
      .from('documents')
      .upload(fileName, file)
    
    if (uploadError) throw uploadError

    // Create document record
    const { data: doc, error: dbError } = await supabase
      .from('documents')
      .insert([{
        entity_type: entityType,
        entity_id: entityId,
        document_type: documentType,
        file_name: file.name,
        file_path: fileName,
        file_size: file.size,
        mime_type: file.type,
        uploaded_by: (await supabase.auth.getUser()).data.user.id,
      }])
      .select()
    
    if (dbError) throw dbError
    return doc[0]
  },

  async list(entityType, entityId) {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('uploaded_at', { ascending: false })
    
    if (error) throw error
    return data
  },

  async verify(documentId, isVerified, notes) {
    const { data, error } = await supabase
      .from('documents')
      .update({
        verification_status: isVerified ? 'verified' : 'rejected',
        verified_by: (await supabase.auth.getUser()).data.user.id,
        verified_at: new Date().toISOString(),
        verification_notes: notes,
      })
      .eq('id', documentId)
      .select()
    
    if (error) throw error
    return data[0]
  },

  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase
      .storage
      .from('documents')
      .createSignedUrl(filePath, expiresIn)
    
    if (error) throw error
    return data.signedUrl
  },
}
```

---

## 4️⃣ FEATURE IMPLEMENTATION

### 4.1 Enhanced Auth Hook with Role Switching
**File**: `src/hooks/useAuth.js`
```javascript
// Add support for viewing as different role (Super Admin feature)
export function useAuth() {
  // ... existing code ...
  const [viewingAsRole, setViewingAsRole] = useState(null)

  const canSwitchViews = role === 'super_admin'
  
  const effectiveRole = viewingAsRole || role
  
  // Provides convenient access to what the user can do
  const permissions = {
    canApproveLoans: ['admin', 'branch_manager', 'loan_officer'].includes(effectiveRole),
    canVerifyDocuments: ['admin', 'loan_officer'].includes(effectiveRole),
    canManageHR: ['admin', 'hr_manager'].includes(effectiveRole),
    canManageUsers: ['admin', 'super_admin'].includes(effectiveRole),
    canViewAudit: ['admin', 'super_admin'].includes(effectiveRole),
  }

  return {
    // ... existing returns ...
    viewingAsRole,
    setViewingAsRole,
    canSwitchViews,
    effectiveRole,
    permissions,
  }
}
```

### 4.2 Role Switcher Component
**File**: `src/components/RoleSwitcher.jsx`
```javascript
import React from 'react'
import { useAuth } from '../hooks/useAuth'
import { ROLE_METADATA, ROLES } from '../constants/roles'

export default function RoleSwitcher() {
  const { canSwitchViews, viewingAsRole, setViewingAsRole, role } = useAuth()
  
  if (!canSwitchViews) return null

  const availableRoles = [
    ROLES.SUPER_ADMIN,
    ROLES.CUSTOMER,
    ROLES.LOAN_OFFICER,
    ROLES.HR_MANAGER,
    ROLES.BRANCH_MANAGER,
  ]

  return (
    <div className="bg-white rounded-lg border border-purple-200 p-4 mb-6">
      <p className="text-sm font-medium text-slate-700 mb-3">
        Super Admin: View as different role
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setViewingAsRole(null)}
          className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
            !viewingAsRole
              ? 'bg-purple-600 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          Your Role: {ROLE_METADATA[role]?.label || role}
        </button>
        {availableRoles.map((r) => (
          <button
            key={r}
            onClick={() => setViewingAsRole(r)}
            className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
              viewingAsRole === r
                ? 'bg-purple-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {ROLE_METADATA[r]?.label || r}
          </button>
        ))}
      </div>
      {viewingAsRole && (
        <p className="text-xs text-purple-600 mt-2">
          👁️ Viewing as {ROLE_METADATA[viewingAsRole]?.label}
        </p>
      )}
    </div>
  )
}
```

### 4.3 My Work Dashboard
**File**: `src/pages/MyWork.jsx`
```javascript
import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { taskService } from '../services/taskService'
import { formatCurrency, StatusBadge } from '../lib/utils'
import { AlertCircle, CheckCircle, Clock, Zap } from 'lucide-react'

export default function MyWork() {
  const { user, role } = useAuth()
  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const taskList = await taskService.list({
          assignedTo: user.id,
          status: filter !== 'all' ? filter : undefined,
        })
        setTasks(taskList)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user.id, filter])

  const tasksByPriority = {
    critical: tasks.filter((t) => t.priority === 'critical'),
    high: tasks.filter((t) => t.priority === 'high'),
    normal: tasks.filter((t) => t.priority === 'normal'),
    low: tasks.filter((t) => t.priority === 'low'),
  }

  const stats = {
    total: tasks.length,
    critical: tasksByPriority.critical.length,
    overdue: tasks.filter((t) => new Date(t.due_date) < new Date()).length,
  }

  const TaskCard = ({ task }) => (
    <div className="bg-white rounded-lg border border-slate-200 p-4 hover:shadow-md transition">
      <div className="flex items-start justify-between mb-2">
        <h4 className="font-medium text-slate-900 flex-1">{task.title}</h4>
        <span className={`px-2 py-1 rounded text-xs font-medium ${
          task.priority === 'critical' ? 'bg-rose-100 text-rose-700' :
          task.priority === 'high' ? 'bg-orange-100 text-orange-700' :
          'bg-slate-100 text-slate-700'
        }`}>
          {task.priority}
        </span>
      </div>
      <p className="text-sm text-slate-600 mb-3">{task.description}</p>
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span>{task.task_type}</span>
        {task.due_date && <span>Due: {new Date(task.due_date).toLocaleDateString()}</span>}
      </div>
    </div>
  )

  if (loading) return <div className="text-center py-12">Loading tasks...</div>

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">My Work</h2>
        <p className="text-sm text-slate-500 mt-1">Tasks assigned to you</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-blue-600" />
            <div>
              <p className="text-xs text-slate-500">Total Tasks</p>
              <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600" />
            <div>
              <p className="text-xs text-slate-500">Critical</p>
              <p className="text-2xl font-bold text-slate-900">{stats.critical}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <Zap className="w-5 h-5 text-orange-600" />
            <div>
              <p className="text-xs text-slate-500">Overdue</p>
              <p className="text-2xl font-bold text-slate-900">{stats.overdue}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        {['pending', 'in_progress', 'completed', 'all'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1).replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {Object.entries(tasksByPriority).map(([priority, priorityTasks]) => (
          priorityTasks.length > 0 && (
            <div key={priority}>
              <h3 className="text-sm font-semibold text-slate-700 mb-3 capitalize">
                {priority === 'critical' && '🔴'} {priority} Priority
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
                {priorityTasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </div>
          )
        ))}
        {tasks.length === 0 && (
          <div className="text-center py-12 bg-slate-50 rounded-lg">
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-3" />
            <p className="text-slate-600">No tasks assigned to you</p>
          </div>
        )}
      </div>
    </div>
  )
}
```

### 4.4 Customer Dashboard
**File**: `src/pages/CustomerDashboard.jsx`
```javascript
import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabaseClient'
import { formatCurrency, StatusBadge } from '../lib/utils'
import { Wallet, Landmark, Clock, FileText } from 'lucide-react'

export default function CustomerDashboard() {
  const { user, name } = useAuth()
  const [customer, setCustomer] = useState(null)
  const [loans, setLoans] = useState([])
  const [applications, setApplications] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        // Get customer record created by this user (linked by created_by)
        const { data: cust } = await supabase
          .from('customers')
          .select('*')
          .eq('created_by', user.id)
          .single()
        
        if (cust) {
          setCustomer(cust)

          // Get active loans
          const { data: loansList } = await supabase
            .from('loans')
            .select('*')
            .eq('customer_id', cust.id)
            .eq('status', 'active')
          setLoans(loansList || [])

          // Get loan applications
          const { data: appsList } = await supabase
            .from('loan_applications')
            .select('*')
            .eq('customer_id', cust.id)
            .order('created_at', { ascending: false })
          setApplications(appsList || [])
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user.id])

  if (loading) return <div className="text-center py-12">Loading...</div>
  if (!customer) return <div className="text-center py-12">No customer profile found</div>

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-slate-900">
          Welcome, {name.split(' ')[0]}
        </h2>
        <p className="text-slate-500 mt-1">Your Infinity Bank Account</p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl p-6 text-white">
          <p className="text-sm opacity-90 mb-2">Available Balance</p>
          <p className="text-3xl font-bold">₦{formatCurrency(customer.account_balance || 0)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <p className="text-sm text-slate-500 mb-2">KYC Status</p>
          <div className="flex items-center justify-between">
            <p className="text-2xl font-bold text-slate-900">{customer.kyc_completion || 0}%</p>
            <span className={`px-3 py-1 rounded-lg text-sm font-medium ${
              (customer.kyc_completion || 0) >= 80
                ? 'bg-green-100 text-green-700'
                : 'bg-orange-100 text-orange-700'
            }`}>
              {(customer.kyc_completion || 0) >= 80 ? 'Complete' : 'In Progress'}
            </span>
          </div>
        </div>
      </div>

      {/* Active Loans */}
      {loans.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Landmark className="w-5 h-5 text-blue-600" />
            Active Loans
          </h3>
          <div className="space-y-3">
            {loans.map((loan) => (
              <div key={loan.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <div>
                  <p className="font-medium text-slate-900">{formatCurrency(loan.principal_amount)}</p>
                  <p className="text-sm text-slate-500">Next payment: ₦{formatCurrency(loan.monthly_payment)}</p>
                </div>
                <span className="text-sm font-medium text-slate-600">{loan.term_months} months</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <button className="p-4 rounded-lg bg-slate-50 hover:bg-slate-100 transition text-center">
            <Wallet className="w-6 h-6 text-blue-600 mx-auto mb-2" />
            <p className="text-xs font-medium text-slate-700">Apply for Loan</p>
          </button>
          <button className="p-4 rounded-lg bg-slate-50 hover:bg-slate-100 transition text-center">
            <FileText className="w-6 h-6 text-green-600 mx-auto mb-2" />
            <p className="text-xs font-medium text-slate-700">Upload Documents</p>
          </button>
          <button className="p-4 rounded-lg bg-slate-50 hover:bg-slate-100 transition text-center">
            <Clock className="w-6 h-6 text-orange-600 mx-auto mb-2" />
            <p className="text-xs font-medium text-slate-700">View Schedule</p>
          </button>
          <button className="p-4 rounded-lg bg-slate-50 hover:bg-slate-100 transition text-center">
            <FileText className="w-6 h-6 text-purple-600 mx-auto mb-2" />
            <p className="text-xs font-medium text-slate-700">Support</p>
          </button>
        </div>
      </div>

      {/* Recent Applications */}
      {applications.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">Recent Applications</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-6 py-3 text-left font-medium">Amount</th>
                <th className="px-6 py-3 text-left font-medium">Status</th>
                <th className="px-6 py-3 text-left font-medium">Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {applications.slice(0, 5).map((app) => (
                <tr key={app.id}>
                  <td className="px-6 py-3 font-medium text-slate-900">{formatCurrency(app.amount)}</td>
                  <td className="px-6 py-3">
                    <StatusBadge
                      label={app.status}
                      color={app.status === 'approved' ? 'green' : app.status === 'pending' ? 'yellow' : 'red'}
                    />
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {new Date(app.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

### 4.5 Customer 360 Modal
**File**: `src/components/Customer360Modal.jsx`
```javascript
import React, { useState } from 'react'
import { X, FileText, AlertCircle, MessageSquare } from 'lucide-react'
import { formatCurrency } from '../lib/utils'

export default function Customer360Modal({ customer, onClose, onAction }) {
  const [activeTab, setActiveTab] = useState('overview')

  if (!customer) return null

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'loans', label: 'Loans' },
    { key: 'documents', label: 'Documents' },
    { key: 'interactions', label: 'Interactions' },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-xl font-semibold text-slate-900">Customer 360</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Customer Header */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">{customer.name}</h3>
              <p className="text-sm text-slate-500">{customer.email}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500 mb-1">Status</p>
              <span className="px-3 py-1 rounded-lg text-sm font-medium bg-green-100 text-green-700">
                Active
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 px-6 pt-4 border-b border-slate-200">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 px-2 font-medium transition border-b-2 ${
                activeTab === tab.key
                  ? 'text-blue-600 border-blue-600'
                  : 'text-slate-600 border-transparent hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-500 mb-1">Phone</p>
                  <p className="font-medium text-slate-900">{customer.phone}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Email</p>
                  <p className="font-medium text-slate-900">{customer.email}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Date of Birth</p>
                  <p className="font-medium text-slate-900">
                    {customer.date_of_birth ? new Date(customer.date_of_birth).toLocaleDateString() : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Employment</p>
                  <p className="font-medium text-slate-900">{customer.employment_status}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'loans' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">No active loans</p>
            </div>
          )}

          {activeTab === 'documents' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">No documents uploaded</p>
            </div>
          )}

          {activeTab === 'interactions' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">No interaction history</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-slate-200 flex gap-3">
          <button
            onClick={() => onAction('createCase')}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
          >
            <MessageSquare className="w-4 h-4 inline mr-2" />
            Create Support Case
          </button>
          <button
            onClick={() => onAction('uploadDoc')}
            className="flex-1 px-4 py-2 bg-slate-100 text-slate-900 rounded-lg font-medium hover:bg-slate-200"
          >
            <FileText className="w-4 h-4 inline mr-2" />
            Upload Document
          </button>
          <button onClick={onClose} className="px-4 py-2 text-slate-600 hover:text-slate-900">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
```

### 4.6 HR Jobs List
**File**: `src/pages/HRJobs.jsx`
```javascript
import React, { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { Briefcase, Plus, Users } from 'lucide-react'

export default function HRJobs() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await supabase
          .from('hr_jobs')
          .select('*')
          .order('created_at', { ascending: false })
        setJobs(data || [])
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <div className="text-center py-12">Loading jobs...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Job Postings</h2>
          <p className="text-sm text-slate-500 mt-1">Manage open positions</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Job
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {jobs.map((job) => (
          <div key={job.id} className="bg-white rounded-lg border border-slate-200 p-6 hover:shadow-md transition">
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">{job.job_title}</h3>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                job.status === 'published' ? 'bg-green-100 text-green-700' :
                job.status === 'closed' ? 'bg-slate-100 text-slate-700' :
                'bg-yellow-100 text-yellow-700'
              }`}>
                {job.status}
              </span>
            </div>
            <p className="text-sm text-slate-600 mb-4">{job.description}</p>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{job.department}</span>
              <span>{job.location}</span>
            </div>
          </div>
        ))}
      </div>

      {jobs.length === 0 && (
        <div className="text-center py-12 bg-slate-50 rounded-lg">
          <Briefcase className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600">No jobs posted yet</p>
        </div>
      )}
    </div>
  )
}
```

---

## 5️⃣ TESTING & VALIDATION

### 5.1 Test Scenarios

**Security Testing**:
- [ ] Customer A cannot see Customer B's data
- [ ] Staff member can't approve loans outside their permission level
- [ ] Audit logs show all changes with actor information
- [ ] Documents are only accessible to authorized users

**Functionality Testing**:
- [ ] Document upload works with file validation
- [ ] Task creation auto-assigns to user
- [ ] Customer dashboard shows only their data
- [ ] My Work queue displays correctly
- [ ] Super Admin can switch between all views
- [ ] Customer 360 shows correct customer info

**Data Consistency**:
- [ ] Loan applications create tasks automatically
- [ ] Document verification updates application status
- [ ] Task completion creates audit log

---

## 6️⃣ DEPLOYMENT CHECKLIST

- [ ] All database migrations applied to Supabase
- [ ] RLS policies tested thoroughly
- [ ] Environment variables configured
- [ ] Supabase storage bucket created for documents
- [ ] Components tested on mobile
- [ ] Audit logs verified
- [ ] Role permissions tested
- [ ] Customer data isolation verified
- [ ] Performance tested with sample data
- [ ] Error handling verified
- [ ] Build passes without errors (`npm run build`)

---

## 📅 IMPLEMENTATION TIMELINE

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1.1: Database & Security | 3 days | Schema + RLS policies + audit logging |
| 1.2: Architecture | 2 days | Enhanced auth, permissions, services |
| 1.3: Core Features | 4 days | My Work, documents, Customer 360 |
| 1.4: Customer Experience | 3 days | Customer dashboard, role switching |
| 1.5: HR Foundation | 3 days | Jobs, candidates, assessments tables |
| 1.6: Testing & Polish | 2 days | Security testing, bug fixes, optimization |

**Total: ~17 days** (2-3 weeks with normal development pace)

---

## 🎯 SUCCESS CRITERIA

By end of Phase 1, you should be able to:

1. ✅ Log in as different roles and see distinct experiences
2. ✅ Super Admin can click button to view as different role
3. ✅ Upload documents with verification workflow
4. ✅ See "My Work" queue with assigned tasks
5. ✅ Customer sees personalized dashboard (not internal ops)
6. ✅ Staff can open Customer 360 and see relevant info
7. ✅ HR staff can create jobs and candidates
8. ✅ All changes are audited with full traceability
9. ✅ RLS prevents unauthorized data access
10. ✅ Application builds without errors

---

## 📝 NOTES

- This plan preserves all existing functionality
- Components are modular and reusable
- Database schema is future-proof
- Security is enforced at DB level, not just UI
- Each section can be built independently
- Testing happens continuously, not just at end

**Next step**: Start with database migrations.
