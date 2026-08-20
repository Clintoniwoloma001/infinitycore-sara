# Phase 1 Implementation - README
## Clinton Iwoloma's Infinity Core Banking Platform

> Building the foundation for a secure, role-aware digital banking platform with distinct customer and staff experiences.

---

## 📌 What's in This Branch?

This `phase-1-implementation` branch contains **complete Phase 1 development** for Infinity Core. By the end of this phase, you'll have:

✅ **Security Hardening** - Enhanced RLS policies preventing unauthorized data access  
✅ **Role-Aware Architecture** - Support for 11+ distinct roles with granular permissions  
✅ **Document Management** - Full file upload, verification, and workflow integration  
✅ **My Work Queue** - Central task management dashboard for staff  
✅ **Customer Dashboard** - Distinct banking experience for customers  
✅ **Customer 360** - Comprehensive staff view of customer profiles  
✅ **HR Module Foundation** - Jobs, candidates, assessments, interviews  
✅ **Super Admin View Switching** - Test the app as different roles instantly  
✅ **Audit Trail** - Complete logging of all data changes  
✅ **Extensible Config System** - No more hardcoded values  

---

## 📂 Project Structure

```
src/
├── constants/
│   ├── roles.js                    # All role definitions, hierarchy, metadata
│   └── permissions.js              # Granular permission keys and categories
├── services/
│   ├── taskService.js              # My Work queue management
│   ├── documentService.js          # File upload and verification workflow
│   ├── supportCaseService.js       # Customer support ticket system
│   └── hrService.js                # HR recruitment and management
├── hooks/
│   └── useAuth.js                  # Enhanced with role switching capability
├── components/
│   ├── RoleSwitcher.jsx            # Super Admin feature to test all roles
│   ├── DocumentUpload.jsx          # Drag-drop file upload component
│   ├── DocumentList.jsx            # Display and manage documents
│   └── Customer360Modal.jsx        # Comprehensive customer profile view
├── pages/
│   ├── MyWork.jsx                  # Staff task dashboard
│   ├── CustomerDashboard.jsx       # Customer banking experience
│   └── HRJobs.jsx                  # HR job management
└── ...

Database Migrations:
├── schema_phase1_migrations.sql     # All new tables, RLS policies, functions
```

---

## 🚀 Getting Started

### Step 1: Apply Database Migrations

**CRITICAL: Do this first!**

1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Select your `infinitycore` project
3. Go to **SQL Editor**
4. Copy all SQL from `schema_phase1_migrations.sql`
5. Paste and run
6. Verify all tables created successfully

**Tables created:**
- `documents` - File uploads with verification
- `tasks` - My Work queue
- `support_cases` - Customer support tickets
- `hr_jobs`, `hr_candidates`, `hr_assessments`, `hr_interviews`, `employees` - HR module
- `roles`, `permissions`, `role_permissions` - Role-based access control
- `system_config` - Configuration values (no more hardcoding!)

### Step 2: Create Supabase Storage Bucket

1. In Supabase Dashboard, go to **Storage**
2. Click **New Bucket**
3. Name: `documents`
4. Make it **Private**
5. Click **Create**

### Step 3: Update Frontend Code

1. Pull this branch: `git checkout phase-1-implementation`
2. Install dependencies: `npm install`
3. Build to check for errors: `npm run build`

### Step 4: Test the Implementation

```bash
npm run dev
```

Then:
1. Log in with your admin account
2. You should see **RoleSwitcher** component at the top
3. Click different roles to test the "view as" feature
4. Navigate to each new page to verify it works

---

## 🎯 Key Features Explained

### 1. Enhanced Authentication Hook (`useAuth.js`)

The `useAuth()` hook now provides:

```javascript
const {
  // Auth state
  user,                    // Supabase auth user
  profile,                 // User profile from DB
  
  // Role information
  actualRole,              // User's real role
  effectiveRole,           // Actual or viewing-as role
  roleMetadata,            // Display info (label, color, icon)
  
  // Role switching (Super Admin only)
  viewingAsRole,           // Current viewing-as role
  setViewingAsRole,        // Change viewing-as role
  canSwitchViews,          // Is user Super Admin?
  
  // Permissions
  availableModules,        // Array of accessible modules
  userPermissions,         // Array of permission keys
  hasPermission(key),      // Check single permission
  permissions,             // Convenient permission checks
  
  // User info
  name,
  email,
  isAdmin,
  isManager,
  isHR,
  isCustomer,
  isStaff,
} = useAuth()
```

**Usage Example:**
```javascript
const { permissions, effectiveRole } = useAuth()

// Check permission before rendering
{permissions.canApproveLoan && (
  <button>Approve Loan</button>
)}

// Show role-specific content
{effectiveRole === ROLES.CUSTOMER && (
  <CustomerDashboard />
)}
```

### 2. Role Switching (Super Admin Feature)

The **RoleSwitcher** component lets Super Admin test the app as different roles:

```jsx
import RoleSwitcher from '../components/RoleSwitcher'

// In your Layout.jsx or main page:
{canSwitchViews && <RoleSwitcher />}
```

This is NOT a security feature - it's for testing only. Real RLS policies still apply at the database level.

### 3. My Work Dashboard

Staff can see all tasks assigned to them, organized by priority:

- **Critical** (red) - Urgent action needed
- **High** (orange) - Important tasks
- **Normal** (blue) - Regular work
- **Low** (gray) - Can wait

Features:
- Filter by status (pending, in_progress, completed)
- Quick stats (total, critical, overdue)
- Click to expand and view full details
- Mark complete and add notes

### 4. Customer Dashboard

Distinct experience for customers:

- Account balance and KYC status
- Active loans overview
- Recent applications
- Quick actions (Apply for Loan, Upload Documents, etc.)
- Does NOT show internal operations

### 5. Customer 360 Modal

Staff view of a customer with all relevant info:

- Personal information
- Uploaded documents (with verification status)
- Active loans
- Interaction history
- Quick actions (create support case, start loan)

### 6. Document Upload & Verification

**Upload Component:**
```jsx
<DocumentUpload
  entityType="customer"
  entityId={customer.id}
  documentType="national_id"
  accept=".pdf,.jpg,.png"
  onSuccess={(doc) => console.log(doc)}
  onError={(err) => console.error(err)}
/>
```

**Verification Workflow:**
- Users upload documents
- Status: `pending` (default)
- Loan officers verify: `verified` or `rejected`
- Verification notes included
- Audit logged automatically

### 7. My Work Queue (Tasks)

Create tasks for staff:

```javascript
const { taskService } = require('../services/taskService')

// Create a task
await taskService.create({
  title: 'Review Loan Application',
  description: 'Check and assess risk score',
  task_type: 'assessment',
  entity_type: 'loan_application',
  entity_id: loanId,
  assigned_to: staffUserId,
  priority: 'high',
  due_date: '2024-08-20',
  related_customer_id: customerId,
})

// Get assigned tasks
const tasks = await taskService.list({
  assignedTo: userId,
  status: 'pending',
})

// Complete a task
await taskService.complete(taskId, 'Approved with low risk')
```

### 8. HR Module

Create jobs, manage candidates, schedule interviews:

```javascript
const { hrService } = require('../services/hrService')

// Create job
await hrService.createJob({
  job_title: 'Loan Officer',
  department: 'Lending',
  location: 'Lagos',
  employment_type: 'full_time',
  description: '...',
  requirements: '...',
})

// Screen candidate
await hrService.screenCandidate(candidateId, 78, 'Strong CV')

// Schedule interview
await hrService.scheduleInterview({
  candidate_id: candidateId,
  scheduled_date: new Date('2024-08-25'),
  interview_type: 'video',
  interviewer_id: userId,
})
```

### 9. Role-Based Permissions

**Check permissions:**

```javascript
const { hasPermission, permissions } = useAuth()

// Method 1: Use convenience object
if (permissions.canApproveLoan) { ... }
if (permissions.canVerifyDocuments) { ... }

// Method 2: Check specific permission
if (hasPermission('loans.approve_high')) { ... }

// Method 3: Check multiple (any)
if (hasAnyPermission(['loans.approve_low', 'loans.approve_medium'])) { ... }
```

**Permission Keys:**
```
Customers:     customers.{read,create,update,delete}
Loans:         loans.{read,create,assess,approve_low,approve_medium,approve_high,disburse}
Documents:     documents.{upload,read,verify,delete}
HR:            hr.{jobs.create,jobs.manage,applications.read,applications.screen,assessments.create,interviews.schedule,hire}
Support:       support.{create,read,resolve}
Admin:         admin.{manage_users,view_audit,manage_config}
```

### 10. Audit Logging

Every change is logged automatically:

```sql
-- Automatically tracked:
INSERT loan_applications (...)  -- Logged
UPDATE loan_applications SET status = 'approved'  -- Logged with old/new values
UPDATE documents SET verification_status = 'verified'  -- Logged with notes
```

View audit logs:
```javascript
const { data: logs } = await supabase
  .from('audit_logs')
  .select('*')
  .order('created_at', { ascending: false })
```

---

## 🔒 Security Model

### Row Level Security (RLS)

**Database-level enforcement:**

- ✅ Customers: Users only see assigned customers
- ✅ Loans: Users only see loans they created or are assigned
- ✅ Documents: Only uploaders, verifiers, or admins can access
- ✅ Tasks: Only assigned staff can see/update
- ✅ Support Cases: Customers see own, staff see assigned
- ✅ HR: HR staff and admins only

**Example RLS Policy:**
```sql
create policy "tasks_read_assigned" on public.tasks
  for select using (
    assigned_to = auth.uid() 
    or created_by = auth.uid() 
    or public.current_role() = 'admin'
  );
```

### Permissions Model

**3-layer enforcement:**
1. **Database RLS** - Prevents query execution
2. **Frontend checks** - Hide buttons, disable forms
3. **API validation** - (When you add backend)

---

## 📋 Database Schema Overview

### New Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `documents` | File uploads | entity_type, entity_id, verification_status |
| `tasks` | My Work queue | assigned_to, status, priority, due_date |
| `support_cases` | Customer support | customer_id, assigned_to, status, priority |
| `hr_jobs` | Job postings | job_title, status, salary_min/max |
| `hr_candidates` | Applicants | job_id, application_status, screening_score |
| `hr_assessments` | Tests | candidate_id, assessment_type, score |
| `hr_interviews` | Interviews | candidate_id, interviewer_id, rating |
| `employees` | Hired staff | user_id, department, position |
| `roles` | Role definitions | role_name, display_name, is_system_role |
| `permissions` | Permission keys | permission_key, category |
| `role_permissions` | Role→Permission mapping | role_id, permission_id |
| `system_config` | Config values | config_key, config_value, config_type |

### Updated Tables

| Table | Changes |
|-------|----------|
| `profiles` | Added `role_id` (links to `roles` table) |

---

## 🧪 Testing Checklist

Before merging to main, verify:

### Security
- [ ] Customer A cannot see Customer B's data
- [ ] Staff member can't access data outside their role
- [ ] Audit logs show all changes with actor
- [ ] RLS policies prevent query execution (check network tab)

### Functionality
- [ ] Upload document → appears in list → verify → status updates
- [ ] Create task → assigned user sees in My Work → mark complete
- [ ] Customer sees own dashboard (not staff view)
- [ ] Staff opens Customer 360 → sees correct customer data
- [ ] Super Admin can switch roles → UI updates
- [ ] Create job → Publish → Appears as published
- [ ] All pages load without errors

### Data
- [ ] No hardcoded values (loan interest rate from config)
- [ ] Timestamps correct
- [ ] Permissions sync with roles
- [ ] Audit logs comprehensive

---

## 📖 Code Examples

### Example 1: Conditional Rendering by Role

```jsx
import { useAuth } from '../hooks/useAuth'
import { ROLES } from '../constants/roles'

export default function Dashboard() {
  const { effectiveRole, permissions } = useAuth()

  return (
    <>
      {effectiveRole === ROLES.CUSTOMER && (
        <CustomerDashboard />
      )}
      
      {effectiveRole === ROLES.LOAN_OFFICER && (
        <LoanOfficerDashboard />
      )}
      
      {effectiveRole === ROLES.HR_MANAGER && (
        <HRDashboard />
      )}
      
      {/* Show based on permission */}
      {permissions.canVerifyDocuments && (
        <DocumentVerificationPanel />
      )}
    </>
  )
}
```

### Example 2: Auto-Create Task from Loan

```javascript
import { taskService } from '../services/taskService'

// When loan application is created
const loanApp = await createLoanApplication(...)

// Auto-create review task
await taskService.createFromEntity('loan_application', loanApp.id, {
  title: `Review Loan Application - ${customer.name}`,
  task_type: 'assessment',
  priority: 'high',
  assigned_to: loanOfficerId,
  related_customer_id: customerId,
})
```

### Example 3: Document Upload Workflow

```jsx
import DocumentUpload from '../components/DocumentUpload'
import DocumentList from '../components/DocumentList'
import { documentService } from '../services/documentService'

export default function KYCForm({ customerId }) {
  const [docs, setDocs] = useState([])
  const [verifyingId, setVerifyingId] = useState(null)

  const loadDocs = async () => {
    const documents = await documentService.list('customer', customerId)
    setDocs(documents)
  }

  useEffect(() => {
    loadDocs()
  }, [customerId])

  const handleVerify = async (docId, isVerified) => {
    await documentService.verify(docId, isVerified, 'Looks good')
    loadDocs() // Refresh list
  }

  return (
    <div>
      <h3>Upload National ID</h3>
      <DocumentUpload
        entityType="customer"
        entityId={customerId}
        documentType="national_id"
        onSuccess={loadDocs}
      />

      <h3>Uploaded Documents</h3>
      <DocumentList
        documents={docs}
        canVerify={permissions.canVerifyDocuments}
        onVerify={handleVerify}
      />
    </div>
  )
}
```

---

## 🐛 Troubleshooting

### Issue: "Document upload fails"
**Solution:** Check Supabase Storage bucket exists and is named `documents`

### Issue: "Task doesn't appear in My Work"
**Solution:** Check `assigned_to` field matches current user ID

### Issue: "Customer sees staff dashboard"
**Solution:** Check user's `role` is set to `customer` in profiles table

### Issue: "RLS blocks all queries"
**Solution:** Run `schema_phase1_migrations.sql` again - RLS policies may not have applied

### Issue: "Role switcher not showing"
**Solution:** User must be `super_admin` role in database

---

## 📚 Next Steps After Phase 1

1. **Phase 2**: Customer Experience - Build self-service loan application flow
2. **Phase 3**: Staff Operations - Enhanced Customer 360, case management
3. **Phase 4**: Loan Workflow - Disbursement, repayment, escalation
4. **Phase 5**: HR Module - Full recruitment pipeline
5. **Phase 6**: Automation Engine - Workflow builder
6. **Phase 7**: Intelligence Layer - Manager dashboards, AI assistance
7. **Phase 8**: Polish & Scale - Performance, accessibility, production hardening

---

## 📞 Questions?

Refer to:
- `PHASE_1_IMPLEMENTATION_PLAN.md` - Detailed architecture
- `schema_phase1_migrations.sql` - Database schema
- Component files - Inline code comments
- Service files - JSDoc comments

---

**Built by Clinton Iwoloma**  
**Phase 1: Foundation & Security**  
**Status: Ready for Testing**
