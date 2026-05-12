// Shared UI constants. Lives in its own file so callers across the host
// and the webview share the same numbers without duplicating them.

// Cap the on-screen event row count. Both the host-side audit panel and
// the webview ring-trim use this — previously each had its own MAX_EVENTS
// constant that could drift.
export const MAX_AUDIT_EVENTS = 100;

export const AUDIT_TRUNCATE_LEN = 120;
