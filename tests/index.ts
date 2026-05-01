// Bundled entry for the test suite. esbuild rolls every test file
// referenced here into one bundle that `node --test` walks.

import './render.test';
import './storage.test';
import './anchor.test';
import './disposables.test';
import './geometry.test';
import './layout.test';
