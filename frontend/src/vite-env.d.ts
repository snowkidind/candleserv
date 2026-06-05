/// <reference types="vite/client" />

// Build-time constant injected by vite.config.ts `define` — short git SHA of
// HEAD when the bundle was built ("unknown" outside a git checkout).
declare const __GIT_COMMIT__: string;
