#!/usr/bin/env node
// Inject --attach so zlm always opens the TUI in attach mode
process.argv.push('--attach');
require('../dist/index.js');
