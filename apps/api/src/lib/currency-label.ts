/**
 * Moved to `packages/shared` (§9: one definition, imported by both apps).
 *
 * Re-exported rather than deleted so the seven call sites here keep their local
 * import. The rule itself now has one home, which is what the note that used to
 * live on it asked for.
 */
export { isoCurrency } from '@ff/shared';
