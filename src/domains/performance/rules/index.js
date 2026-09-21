// ------------------------------------------------------------------
// Performance Rules Builder — domain logic.
// Configuration-layer only. Describes what HR can configure and how the
// stored JSON maps to/from business drafts; it never computes MPR/PAR
// scores, bonuses or sanctions. The calculation engine is untouched.
// ------------------------------------------------------------------

export * from './registry.js'
export * from './format.js'
export * from './validate.js'
export { translators, getTranslator, fallbackTranslator, isDirty } from './translators.js'