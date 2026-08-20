import React from 'react'
import { date, ModuleTable, money, status, useTable } from './hrShared'

export default function Payroll() {
  const { rows, loading, error } = useTable('payroll')

  return (
    <ModuleTable
      title="Payroll"
      subtitle="Payroll periods, salary, allowances, deductions, net pay, and approval status"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['employee_name', 'payroll_period', 'status']}
      columns={[
        { key: 'employee_name', label: 'Employee', render: (r) => r.employee_name || r.full_name || r.employee_id || '-' },
        { key: 'salary', label: 'Salary', render: (r) => money(r.salary || r.base_salary) },
        { key: 'allowances', label: 'Allowances', render: (r) => money(r.allowances) },
        { key: 'deductions', label: 'Deductions', render: (r) => money(r.deductions) },
        { key: 'net_pay', label: 'Net Pay', render: (r) => money(r.net_pay || (Number(r.salary || r.base_salary || 0) + Number(r.allowances || 0) - Number(r.deductions || 0))) },
        { key: 'payroll_period', label: 'Period', render: (r) => r.payroll_period || date(r.period_start) },
        { key: 'status', label: 'Status', render: (r) => status(r.status, ['approved', 'paid', 'processed']) },
      ]}
    />
  )
}
