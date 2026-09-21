// Nigerian commercial / merchant bank catalogue with CBN (NIBSS) codes.
// Used by the BankOne account name-enquiry flow to route a lookup and to
// persist the bank on the employee record. Codes are the NIBSS institution
// codes used across Nigerian payment rails.
export const NIGERIAN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank (FCMB)' },
  { code: '103', name: 'Globus Bank' },
  { code: '058', name: 'Guaranty Trust Bank (GTBank)' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '303', name: 'Lotus Bank' },
  { code: '104', name: 'Parallex Bank' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '106', name: 'Signature Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '100', name: 'SunTrust Bank' },
  { code: '102', name: 'Titan Trust Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa (UBA)' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
]

const BANK_BY_CODE = new Map(NIGERIAN_BANKS.map((b) => [b.code, b]))
const BANK_BY_NAME = new Map(NIGERIAN_BANKS.map((b) => [b.name.toLowerCase(), b]))

export function findBankByCode(code) {
  return BANK_BY_CODE.get(String(code || '').trim()) || null
}

export function findBankByName(name) {
  return BANK_BY_NAME.get(String(name || '').trim().toLowerCase()) || null
}

export default NIGERIAN_BANKS
