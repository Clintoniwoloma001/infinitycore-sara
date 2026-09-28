// ============================================================================
// BankOne column contracts
// ============================================================================
// `expected` drives header DETECTION (how strongly a row looks like the header);
// `required` drives VALIDATION (an import stops if one of these is absent).
// Keeping the two separate means a file that adds or renames a cosmetic column
// still imports, while a file missing a column we genuinely rely on stops with
// a useful message instead of importing misaligned data.

/**
 * Portfolio At Risk (Extended) - profiled from the real export:
 * header on row 3, 66 columns, 2725 loans.
 */
export const PAR_EXPECTED_COLUMNS = [
  'S/N.', 'Account No.', 'Account Officer', 'Customer Name', 'Gender', 'Branch',
  'Disbursement Date', 'Maturation Date', 'Economic Sector', 'Product',
  'Linked Account No.', 'Customer Account Bal.', 'Loan Amount', 'Principal Bal.',
  'Total Outst. Prin.', 'Past Due Prin.', 'Past Due Interest', 'Unpaid Loan Fees',
  'Total Outstanding Amount', 'Loan Arrears', 'Paid Principal', 'Due Interest',
  'Paid Interest', 'Days OverDue', 'Status', 'Expected Credit Loss Stages',
  'Lending Model', 'Past Due Date', 'Last Repayment Date', 'Last Payment Date',
  'Last Payment Amount', 'Repayment mode', 'Next repayment Date', 'NUBAN', 'BVN',
  'Branch Code', 'Region', 'Ministries, Departments and Agencies', 'Collateral Type',
  'Collateral Value', 'Guarantor 1', 'Guarantor 2', 'Guarantor 1 Name',
  'Guarantor 2 Name', 'Guarantor 1 Phone', 'Guarantor 2 Phone', 'Guarantor 1 Address',
  'Guarantor 2 Address', '% of Guarantor 1 Exposure', '% of Guarantor 2 Exposure',
  'Value of Guarantor 1 Exposure', 'Value of Guarantor 2 Exposure', 'Tax ID No',
  'Restructured Loan Maturation Date', 'Refinanced Loan Maturation Date', 'IPPIS',
  'Is Restructured', 'Is Refinanced', 'Phone No.', 'Address', 'Group Name',
  'Association ID', 'Association Name', 'Tenure', 'Interest Rate', 'Unpaid Interest',
]

/** Columns a PAR import genuinely cannot proceed without. */
export const PAR_REQUIRED_COLUMNS = [
  'Account No.', 'Account Officer', 'Branch', 'Disbursement Date',
  'Total Outstanding Amount', 'Days OverDue', 'Status',
]

/**
 * Disbursed loans - profiled from the real export:
 * header on row 8, 30 columns, 8 loans.
 *
 * NOTE: in the real file the 'IPPIS' column carries the customer's business or
 * group name (e.g. 'TILES', 'FRUITS & DRINKS'), not a tax identifier. The
 * header label is wrong at source, so the value is stored as business text and
 * is never presented as an IPPIS number.
 */
export const DISBURSEMENT_EXPECTED_COLUMNS = [
  'Customer ID', 'Customer Name', 'Group Name', 'Account No.', 'Address', 'Branch',
  'Gender', 'Phone No.', 'Ministries, Departments and Agencies', 'Loan Amount',
  'Principal Bal.', 'Disbursement Date', 'Maturation Date', 'Effective Date',
  'Moratarium (day)', 'Restructured Disbursement Date', 'Restructured Maturation Date',
  'Product', 'Linked Account Number', 'Linked Account Name', 'BVN', 'Interest Rate',
  'Prin. Repay.', 'Int. Repay.', 'Account Officer', 'Guarantor 1', 'Guarantor 2',
  'Has Previously Taken Loan', 'Security Deposit', 'IPPIS',
]

/** Columns a disbursement import genuinely cannot proceed without. */
export const DISBURSEMENT_REQUIRED_COLUMNS = [
  'Account No.', 'Account Officer', 'Branch', 'Disbursement Date', 'Loan Amount',
]
