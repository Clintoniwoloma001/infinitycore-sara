# Phase 1 Setup Guide
## Clinton Iwoloma's Infinity Core - Getting Started

---

## ⚡ Quick Start (5 minutes)

### 1. Run Database Migrations

```bash
# Copy entire contents of schema_phase1_migrations.sql
# Go to Supabase Dashboard → SQL Editor → Paste → Run
```

**Verify:** All tables created, no errors in SQL output

### 2. Create Storage Bucket

```bash
# Supabase Dashboard → Storage → New Bucket
# Name: documents
# Type: Private
# Click Create
```

### 3. Pull & Install

```bash
git checkout phase-1-implementation
npm install
npm run build  # Verify no errors
```

### 4. Test Locally

```bash
npm run dev
# Visit http://localhost:5173
```

---

## ✅ Verification Checklist

### Database
- [ ] `documents` table exists
- [ ] `tasks` table exists
- [ ] `support_cases` table exists
- [ ] `hr_*` tables exist (5 tables)
- [ ] `roles` table has 11 rows
- [ ] `permissions` table has ~25 rows
- [ ] `system_config` table has default values
- [ ] `profiles.role_id` column added

### Frontend
- [ ] Build succeeds: `npm run build`
- [ ] No TypeScript errors
- [ ] App loads without console errors

### Features
- [ ] Log in with admin account
- [ ] See **RoleSwitcher** component
- [ ] Click roles to switch view
- [ ] Navigate to "My Work" page (if staff)
- [ ] Navigate to "Customer Dashboard" (if customer)
- [ ] Can upload a test document

---

## 🔑 Test Accounts

Use these roles to test different experiences:

```
Role              | Email Pattern          | Capabilities
------------------+------------------------+---------------------------
super_admin       | admin@test.com         | Everything + role switch
admin             | admin2@test.com        | Everything
loan_officer      | loan@test.com          | Assess & approve loans
hr_manager        | hr@test.com            | Manage HR
customer_service  | support@test.com       | Handle tickets
customer          | customer@test.com      | Customer dashboard only
```

---

## 📊 Testing Scenarios

### Scenario 1: Upload and Verify Document

1. Log in as customer
2. Go to "Customer Dashboard"
3. Click "Upload Document"
4. Upload a PDF/image
5. Log in as loan_officer
6. Go to customer's profile
7. See uploaded document with "pending" status
8. Click verify to approve
9. Log back in as customer - status should be "verified"

### Scenario 2: Assign Task to Staff

1. As admin, create a task (via database INSERT or later API)
2. Assign to a staff user
3. Staff logs in
4. Goes to "My Work"
5. Sees the task
6. Clicks to expand and mark complete

### Scenario 3: Customer vs Staff View

1. Log in as customer
2. See: Account balance, loans, applications
3. Do NOT see: Other customers, audit logs, staff tools
4. Log out, log in as loan_officer
5. See: "My Work", customer list, loan applications
6. Do NOT see: Customer dashboard

### Scenario 4: Role Switching (Super Admin)

1. Log in as super_admin
2. See **RoleSwitcher** component at top
3. Click "Loan Officer" button
4. UI updates to show loan officer view
5. Try accessing admin features - blocked by permissions
6. Click "Reset" to go back

---

## 🗄️ Database Quick Reference

### Key Queries

```sql
-- Check all roles
SELECT * FROM public.roles;

-- Check user permissions
SELECT p.permission_key
FROM public.role_permissions rp
JOIN public.permissions p ON rp.permission_id = p.id
WHERE rp.role_id = (SELECT id FROM public.roles WHERE role_name = 'loan_officer');

-- View pending documents
SELECT * FROM public.documents WHERE verification_status = 'pending';

-- View open tasks
SELECT * FROM public.tasks WHERE status IN ('pending', 'in_progress');

-- Check audit logs
SELECT * FROM public.audit_logs ORDER BY created_at DESC LIMIT 50;

-- View pending support cases
SELECT * FROM public.support_cases WHERE status IN ('open', 'assigned');
```

---

## 🐛 Common Issues

### "Module not found: services/taskService"

**Fix:** Verify files were pushed correctly
```bash
git status  # Check branch is phase-1-implementation
git log --oneline | head  # Verify recent commits
```

### "RLS prevents query execution"

**Fix:** Run migrations again, check RLS policies:
```sql
SELECT * FROM information_schema.tables WHERE table_schema = 'public';
-- Verify all new tables exist
```

### "Customer sees staff features"

**Fix:** Check user profile has `role = 'customer'`:
```sql
SELECT * FROM public.profiles WHERE id = 'user-uuid';
UPDATE public.profiles SET role = 'customer' WHERE id = 'user-uuid';
```

### "Document upload fails"

**Fix:** Verify storage bucket:
1. Supabase Dashboard → Storage
2. Confirm bucket named `documents` exists
3. Confirm it's set to "Private"

### "Task doesn't show in My Work"

**Fix:** Verify task assignment:
```sql
SELECT * FROM public.tasks WHERE assigned_to = 'current-user-id';
-- assigned_to must match current user's ID
```

---

## 🚀 Local Development

### Watch Mode

```bash
npm run dev
# Automatically reloads on file changes
```

### Build Check

```bash
npm run build
# Checks for TypeScript errors
```

### Supabase Local (Advanced)

```bash
# If using Supabase CLI
supabase start  # Start local Supabase
supabase stop   # Stop local Supabase
```

---

## 📂 File Structure Reference

```
phase-1-implementation/
├── PHASE_1_README.md                    ← Main documentation
├── PHASE_1_SETUP_GUIDE.md              ← This file
├── PHASE_1_IMPLEMENTATION_PLAN.md       ← Detailed architecture
├── schema_phase1_migrations.sql         ← Database schema
└── src/
    ├── constants/
    │   ├── roles.js
    │   └── permissions.js
    ├── services/
    │   ├── taskService.js
    │   ├── documentService.js
    │   ├── supportCaseService.js
    │   └── hrService.js
    ├── hooks/
    │   └── useAuth.js
    ├── components/
    │   ├── RoleSwitcher.jsx
    │   ├── DocumentUpload.jsx
    │   ├── DocumentList.jsx
    │   └── Customer360Modal.jsx
    └── pages/
        ├── MyWork.jsx
        ├── CustomerDashboard.jsx
        └── HRJobs.jsx
```

---

## 🔄 Git Workflow

### Before Starting

```bash
git checkout phase-1-implementation
git pull origin phase-1-implementation
```

### Making Changes

```bash
git checkout -b feature/my-feature phase-1-implementation
# ... make changes ...
git add .
git commit -m "Description of changes"
git push origin feature/my-feature
# Create PR on GitHub
```

### Merging to Main

```bash
# When Phase 1 is complete and tested:
git checkout main
git pull
git merge phase-1-implementation
git push
```

---

## 📱 Testing on Mobile

```bash
# Get your local IP
ifconfig | grep "inet"  # macOS/Linux
ipconfig | grep IPv4     # Windows

# Run with public access
npm run dev -- --host

# Visit from phone
http://YOUR_LOCAL_IP:5173
```

---

## 💾 Backup & Restore

### Backup Supabase Database

```bash
# Via Supabase Dashboard:
# Settings → Database → Backups → Create Backup
```

### Export Database as SQL

```bash
# Via Supabase CLI:
supabase db pull > backup.sql
```

---

## ✨ Tips & Tricks

### Quick Test Role Switching

```javascript
// In browser console:
const { useAuth } = require('./src/hooks/useAuth')
const auth = useAuth()
console.log(auth.effectiveRole)  // Current role
console.log(auth.permissions)    // All permissions
```

### Simulate Document Upload

```javascript
// Create mock document
await supabase
  .from('documents')
  .insert([{
    entity_type: 'customer',
    entity_id: 'customer-id',
    document_type: 'national_id',
    file_name: 'test.pdf',
    file_path: 'test/test.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    verification_status: 'pending',
  }])
```

### View All Audit Logs

```javascript
const { data: logs } = await supabase
  .from('audit_logs')
  .select('*')
  .order('created_at', { ascending: false })
console.log(logs)
```

---

## 📞 Support

If you get stuck:

1. **Check browser console** for errors
2. **Check network tab** to see API responses
3. **Check Supabase logs** (Dashboard → Logs)
4. **Review code comments** in service files
5. **Read PHASE_1_IMPLEMENTATION_PLAN.md** for architecture details

---

**Built by Clinton Iwoloma**  
**Last Updated: August 13, 2024**  
**Status: Phase 1 Ready for Testing**
