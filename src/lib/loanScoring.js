// Rule-based loan risk scoring engine for Infinity Bank.
// Mirrors the Base44 version exactly: income-to-loan affordability, employment, repayment history.

export function calculateMonthlyPayment(principal, annualRatePct, termMonths) {
  if (!termMonths || termMonths <= 0) return 0
  if (!annualRatePct || annualRatePct === 0) {
    return Math.round((principal / termMonths) * 100) / 100
  }
  const r = annualRatePct / 100 / 12
  const payment = (principal * r) / (1 - Math.pow(1 + r, -termMonths))
  return Math.round(payment * 100) / 100
}

function bandScore(value, excellent, fair) {
  if (value >= excellent) return 100
  if (value >= fair) return 60
  return 25
}

export function scoreLoanApplication(input) {
  const {
    amount = 0,
    termMonths = 12,
    monthlyIncome = 0,
    monthlyExpenses = 0,
    existingDebt = 0,
    employmentStatus = 'employed',
    repaymentHistoryScore = 50,
    interestRate = 12,
  } = input || {}

  const monthlyPayment = calculateMonthlyPayment(amount, interestRate, termMonths)

  const disposableIncome = Math.max(monthlyIncome - monthlyExpenses - existingDebt, 0)
  const affordabilityRatio = monthlyPayment > 0 ? disposableIncome / monthlyPayment : 0
  const affordabilityScore = bandScore(affordabilityRatio, 3, 1.5)

  const employmentScores = { employed: 100, self_employed: 65, retired: 55, unemployed: 15 }
  const employmentScore = employmentScores[employmentStatus] ?? 40

  const historyScore = bandScore(repaymentHistoryScore, 75, 50)

  const composite = Math.round(
    affordabilityScore * 0.45 + employmentScore * 0.25 + historyScore * 0.3
  )

  let riskLevel, approvalRoute
  if (composite >= 75) { riskLevel = 'low'; approvalRoute = 'auto' }
  else if (composite >= 50) { riskLevel = 'medium'; approvalRoute = 'manager' }
  else { riskLevel = 'high'; approvalRoute = 'senior' }

  return {
    riskScore: composite,
    riskLevel,
    approvalRoute,
    monthlyPayment,
    affordabilityRatio: Math.round(affordabilityRatio * 100) / 100,
    breakdown: { affordability: affordabilityScore, employment: employmentScore, history: historyScore },
  }
}

export const RISK_META = {
  low: { label: 'Low Risk', color: 'emerald', route: 'Auto-Approve' },
  medium: { label: 'Medium Risk', color: 'amber', route: 'Manager Approval' },
  high: { label: 'High Risk', color: 'rose', route: 'Senior Review' },
}

export const LOAN_STATUS_META = {
  pending: { label: 'Pending', color: 'slate' },
  approved: { label: 'Approved', color: 'blue' },
  rejected: { label: 'Rejected', color: 'rose' },
  disbursed: { label: 'Disbursed', color: 'violet' },
  repaid: { label: 'Repaid', color: 'emerald' },
}