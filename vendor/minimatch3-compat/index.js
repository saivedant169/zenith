"use strict";
// The minimatch 3.x API (a callable default export with static helpers) over the patched minimatch 11.0.3.
// eslint 9, @eslint/eslintrc and the import, jsx-a11y and react plugins call the 3.x API; no patched 3.x exists
// for GHSA-g3hv-75wg-m249. shortcut: drop this package once those packages move to minimatch >= 11.0.1.
const { minimatch, Minimatch } = require("minimatch-v11");

module.exports = (path, pattern, options) => minimatch(path, pattern, options);
module.exports.Minimatch = Minimatch;
module.exports.sep = minimatch.sep;
module.exports.GLOBSTAR = minimatch.GLOBSTAR;
module.exports.filter = minimatch.filter;
module.exports.defaults = minimatch.defaults;
module.exports.braceExpand = minimatch.braceExpand;
module.exports.match = minimatch.match;
// minimatch 11 has no makeRe. The only 3.x caller (eslint-plugin-import no-internal-modules) calls .test(path) on it,
// so this returns a matcher with that one method, backed by the patched minimatch.
module.exports.makeRe = (pattern, options) => ({ source: pattern, test: (path) => minimatch(String(path), pattern, options) });
module.exports.default = module.exports;
