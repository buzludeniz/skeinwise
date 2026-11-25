/**
 * Joins a key-shaped test sample from its parts at run time, so the source never holds a literal in a provider's key
 * format (test/no-key-literals.test.ts fails on one). Every sample is fake; split it anywhere inside the prefix.
 */
export const keyShaped = (...parts: string[]): string => parts.join('');
