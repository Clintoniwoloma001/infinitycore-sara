// Section and field definitions for the Onboarding Review Center.
// Mirrors the exact structure of OnboardingForm.jsx — the source of truth.
// Do NOT add fields that don't exist in the form.

import {
  User, Users, Phone, Heart, UserCheck, GraduationCap,
  Briefcase, IdCard, Shield, FileText,
} from 'lucide-react'

export const REVIEW_SECTIONS = [
  {
    id: 'personal',
    title: 'Personal Information',
    tab: 'Personal',
    icon: User,
    fields: [
      { key: 'surname', label: 'Surname' },
      { key: 'first_name', label: 'First Name' },
      { key: 'email', label: 'Email Address' },
      { key: 'phone', label: 'Phone Number' },
      { key: 'date_of_birth', label: 'Date of Birth' },
      { key: 'sex', label: 'Sex' },
      { key: 'state_of_origin', label: 'State of Origin' },
      { key: 'lga', label: 'LGA' },
      { key: 'town', label: 'Town / City' },
      { key: 'residential_address', label: 'Residential Address' },
      { key: 'religion', label: 'Religion' },
      { key: 'denomination', label: 'Denomination' },
      { key: 'nationality', label: 'Nationality' },
    ],
  },
  {
    id: 'family',
    title: 'Marital & Family',
    tab: 'Family',
    icon: Users,
    fields: [
      { key: 'marital_status', label: 'Marital Status' },
      { key: 'living_with_spouse', label: 'Living with spouse?' },
      { key: 'spouse_name', label: 'Spouse Name' },
      { key: 'spouse_occupation', label: 'Spouse Occupation' },
      { key: 'spouse_age', label: 'Spouse Age' },
      { key: 'spouse_business_address', label: 'Spouse Business Address' },
      { key: 'spouse_email', label: 'Spouse Email' },
      { key: 'spouse_phone', label: 'Spouse Phone' },
      { key: 'number_of_children', label: 'Number of Children' },
      { key: 'children_age_range', label: 'Children Age Range' },
    ],
  },
  {
    id: 'contact',
    title: 'Contact & Employment',
    tab: 'Employment',
    icon: Phone,
    fields: [
      { key: 'emergency_contact_name', label: 'Emergency Contact Name' },
      { key: 'emergency_contact_phone', label: 'Emergency Contact Phone' },
      { key: 'department', label: 'Department' },
      { key: 'position', label: 'Position' },
      { key: 'employment_type', label: 'Employment Type' },
      { key: 'branch', label: 'Branch' },
    ],
  },
  {
    id: 'next_of_kin',
    title: 'Next of Kin',
    tab: 'Next of Kin',
    icon: Heart,
    fields: [
      { key: 'next_of_kin_name', label: 'Name' },
      { key: 'next_of_kin_relationship', label: 'Relationship' },
      { key: 'next_of_kin_address', label: 'Address' },
      { key: 'next_of_kin_phone', label: 'Phone' },
    ],
  },
  {
    id: 'beneficiary',
    title: 'Beneficiary',
    tab: 'Beneficiary',
    icon: UserCheck,
    fields: [
      { key: 'beneficiary_name', label: 'Name' },
      { key: 'beneficiary_relationship', label: 'Relationship' },
      { key: 'beneficiary_address', label: 'Address' },
      { key: 'beneficiary_phone', label: 'Phone' },
    ],
  },
  {
    id: 'education',
    title: 'Education',
    tab: 'Education',
    icon: GraduationCap,
    type: 'list',
    columns: [
      { key: 'institution', label: 'Institution' },
      { key: 'education_level', label: 'Level' },
      { key: 'from_year', label: 'From Year' },
      { key: 'to_year', label: 'To Year' },
      { key: 'field_of_study', label: 'Field of Study' },
      { key: 'class_degree', label: 'Class / Degree' },
    ],
  },
  {
    id: 'work_history',
    title: 'Work History',
    tab: 'Experience',
    icon: Briefcase,
    type: 'list',
    columns: [
      { key: 'company_name', label: 'Company' },
      { key: 'position', label: 'Position' },
      { key: 'duties', label: 'Duties' },
      { key: 'start_date', label: 'Start Date' },
      { key: 'end_date', label: 'End Date' },
      { key: 'salary', label: 'Salary' },
      { key: 'supervisor_name', label: 'Supervisor' },
      { key: 'supervisor_phone', label: 'Supervisor Phone' },
      { key: 'reason_for_leaving', label: 'Reason for Leaving' },
    ],
  },
  {
    id: 'guarantor',
    title: 'Guarantor',
    tab: 'Guarantor',
    icon: IdCard,
    fields: [
      { key: 'guarantor_full_name', label: 'Guarantor Full Name' },
      { key: 'guarantor_email', label: 'Guarantor Email' },
      { key: 'guarantor_relationship', label: 'Relationship to Employee' },
    ],
  },
  {
    id: 'fidelity',
    title: 'Fidelity Bond',
    tab: 'Fidelity Bond',
    icon: Shield,
    fields: [
      { key: 'fidelity_surety_name', label: 'Surety Name' },
      { key: 'fidelity_relationship', label: 'Relationship' },
      { key: 'fidelity_occupation', label: 'Occupation' },
      { key: 'fidelity_phone', label: 'Phone' },
      { key: 'fidelity_email', label: 'Email' },
      { key: 'fidelity_bvn', label: 'BVN' },
      { key: 'fidelity_nin', label: 'NIN' },
      { key: 'fidelity_address', label: 'Address' },
      { key: 'fidelity_date', label: 'Signature Date' },
      { key: 'fidelity_signature', label: 'Signature' },
    ],
  },
  {
    id: 'documents',
    title: 'Documents & Declaration',
    tab: 'Documents',
    icon: FileText,
    type: 'documents',
  },
]

// Fields that are correctable on the guarantor verification record
// (these match the existing guarantor_corrections system from Phase 7)
export const GUARANTOR_CORRECTABLE_FIELDS = [
  { key: 'phone', label: 'Phone Number' },
  { key: 'residential_address', label: 'Residential Address' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'employer', label: 'Employer / Business' },
  { key: 'bvn', label: 'BVN' },
  { key: 'nin', label: 'NIN' },
]

// All tabs including the non-form tabs
export const ALL_TABS = [
  { id: 'overview', label: 'Overview' },
  ...REVIEW_SECTIONS.map((s) => ({ id: s.id, label: s.tab })),
  { id: 'corrections', label: 'Corrections' },
  { id: 'timeline', label: 'Timeline' },
]
