// ------------------------------------------------------------------
// Offer letter default content + structure.
//
// These defaults are EDITABLE TEMPLATE CONTENT — HR can rewrite every
// section in HR → Offer Letters → Templates. They are never hard-coded
// into the renderer. Placeholders are resolved at render time.
// ------------------------------------------------------------------

export const DEFAULT_COMPANY = {
  name: 'Infinity Microfinance Bank Ltd',
  short_name: 'Infinity MFB',
  address: '',
  rc_number: '',
  email: '',
  phone: '',
  website: '',
  tagline: '',
  confidentiality_notice: 'Private and Confidential',
}

export const DEFAULT_SIGNATORIES = {
  hr_name: 'Human Resources Manager',
  hr_title: 'Human Resources Manager',
  md_name: 'Managing Director / Chief Executive Officer',
  md_title: 'Managing Director / Chief Executive Officer',
  signature_data: null,
  department: 'Human Resources Department',
}

export const DEFAULT_LETTER = {
  reference_prefix: 'OFR',
  validity_days: 7,
  date_format: 'en-GB',
  currency: 'NGN',
  currency_symbol: '₦',
  currency_position: 'prefix',
  currency_decimals: 2,
}

// The standard numbered document body. Section numbers follow the original
// Infinity Microfinance Bank offer letter layout.
export const DEFAULT_SECTIONS = [
  {
    number: '1.0',
    title: 'HOURS OF WORK',
    body: 'Your working hours shall be as may be determined by the Bank from time to time. As at the date of this offer the Bank\'s working hours are as follows:\n\nResumption Time: {{resumption_time}}\nCustomer Service Hours: {{working_hours}}\nWorking Days: {{working_days}}\nLunch Break: {{lunch_break}}',
  },
  {
    number: '2.0',
    title: 'ORGANISATIONAL COMMITMENT',
    body: 'As an employee of the Bank you are required to devote your full time, attention and ability to the duties assigned to you and to act at all times in the best interest of the Bank. You must not, without the prior written approval of the Bank, engage in any other business or occupation, whether remunerated or not.',
  },
  {
    number: '3.0',
    title: 'PROBATION',
    body: 'Your appointment is subject to a probationary period of {{probation_months}} month(s). During the probation period the Bank shall assess your performance, conduct and suitability for confirmation. The Bank may, at its discretion, extend or terminate the probationary period in line with the conditions of employment.',
  },
  {
    number: '4.0',
    title: 'GUARANTOR / SURETY',
    body: 'As a condition of your employment you are required to provide an acceptable guarantor who shall execute the Bank\'s Guarantor form, confirming his/her responsibility for your fidelity and for the due performance of your duties. Your confirmation of appointment shall be subject to the satisfactory completion of this requirement.',
  },
  {
    number: '5.0',
    title: 'MEDICAL FITNESS',
    body: 'Your employment is conditional upon your being medically fit for the duties of the position. You may be required to undergo a medical examination at the Bank\'s appointed medical facility, and continued employment may be subject to periodic medical checks in line with the Bank\'s policy.',
  },
  {
    number: '6.0',
    title: 'REMUNERATION',
    body: 'Your remuneration shall be as set out in the Remuneration Schedule below. Basic pay and allowances attract statutory deductions (PAYE, pension and other contributions) as required by law and by the Bank\'s policy.',
  },
  {
    number: '7.0',
    title: 'LEAVE ENTITLEMENT',
    body: 'You shall be entitled to {{leave_entitlement}} annual leave per calendar year, subject to the exigencies of the Bank\'s operations and the approval of your supervisor. Leave not taken within the year shall be treated in line with the Bank\'s leave policy.',
  },
  {
    number: '8.0',
    title: 'CONFIDENTIALITY',
    body: 'You shall treat as confidential all information relating to the Bank\'s business, customers, staff, systems, records and affairs that may come to your knowledge during or in connection with your employment. You shall not, without the Bank\'s written consent, disclose any such information to any person or use it for your own or another\'s benefit, during or after your employment with the Bank.',
  },
  {
    number: '9.0',
    title: 'CODE OF CONDUCT',
    body: 'You are required to comply at all times with the Bank\'s Code of Conduct, policies, procedures and standing instructions, and to conduct yourself with the highest degree of integrity, probity and professionalism consistent with the Bank\'s standing as a licensed microfinance bank.',
  },
  {
    number: '10.0',
    title: 'COMPANY POLICIES',
    body: 'Your employment is subject to the Bank\'s rules, policies and administrative circulars as issued and amended from time to time, including but not limited to those governing information technology, internet and electronic communications, gifts and entertainment, and anti-money-laundering and combating the financing of terrorism (AML/CFT) obligations.',
  },
  {
    number: '11.0',
    title: 'TERMINATION / NOTICE',
    body: 'Your employment may be terminated by either party giving the other the period of notice stipulated in the conditions of employment or by payment of salary in lieu of notice. The Bank reserves the right to summarily terminate your appointment in cases of gross misconduct, fraud, or any other action constituting a breach of the conditions of employment.',
  },
  {
    number: '12.0',
    title: 'CONDITIONS OF EMPLOYMENT',
    body: 'This offer is subject to the satisfactory completion of your medical fitness and guarantor requirements, and to the terms and conditions of employment operative at the Bank. {{conditions}}',
  },
  {
    number: '13.0',
    title: 'ACCEPTANCE OF OFFER',
    body: 'Please indicate your acceptance of this offer by signing the acceptance section below and returning a copy of this letter on or before {{acceptance_deadline}}. Your acceptance confirms that you agree to be bound by the terms and conditions of employment as stated above and as may be issued by the Bank from time to time.',
  },
]

// Default salary structure used when a template has not configured one.
// Basic Pay = annual salary; the rest is entered by HR at generation time.
export function defaultSalaryConfig(annualSalary = 0) {
  return {
    annual_salary: Number(annualSalary) || 0,
    monthly_salary: 0,
    mid_month_salary: 0,
    end_month_salary: 0,
    mid_month_ratio: 0.5,
    pay: { basic: Number(annualSalary) || 0, housing: 0, transport: 0, furniture: 0, medical: 0, dressing: 0, utility: 0, lunch: 0, telephone: 0, education: 0 },
    coa: { coa: 0 },
    benefit: { leave_allowance: 0, thirteenth_month: 0, other_benefit: 0 },
    social: { pension: 0, hmo: 0, group_life: 0, other_social: 0 },
  }
}

// Standard opening salutation paragraph (rendered above the number summary).
export const DEFAULT_OPENING = 'With reference to your application and the subsequent interview(s) conducted with us, we are pleased to offer you employment with {{company_name}} on the terms and conditions set out below. Please find below a summary of your offer and the terms and conditions of employment.'

// Build a default template object (used when seeding a template).
export function defaultTemplate(name = 'Standard Staff Offer', overrides = {}) {
  return {
    name,
    template_type: 'standard',
  subject: 'Offer of Employment - {{company_name}}',
    opening: DEFAULT_OPENING,
    body: '',
    reference_prefix: DEFAULT_LETTER.reference_prefix,
    validity_days: DEFAULT_LETTER.validity_days,
    sections: DEFAULT_SECTIONS,
    company_info: { ...DEFAULT_COMPANY },
    signatories: { ...DEFAULT_SIGNATORIES },
    salary_config: defaultSalaryConfig(0),
    is_default: false,
    active: true,
    archived: false,
    ...overrides,
  }
}

export default {
  DEFAULT_COMPANY,
  DEFAULT_SIGNATORIES,
  DEFAULT_LETTER,
  DEFAULT_OPENING,
  DEFAULT_SECTIONS,
  defaultSalaryConfig,
  defaultTemplate,
}
