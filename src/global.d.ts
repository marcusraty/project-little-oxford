// Build-time constants injected by esbuild via `define`.
//
// `__DEBUG__` is true under OXFORD_DEBUG=1 builds and false in production.
// Wrap any diagnostics-only code in `if (__DEBUG__)` so esbuild constant-folds
// it away in prod and the imported diagnostics modules become tree-shakeable.
declare const __DEBUG__: boolean;
