#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const projectIndex = process.argv.indexOf('--project');
const project = projectIndex >= 0 ? process.argv[projectIndex + 1] : null;
if (!project || !path.isAbsolute(project)) { console.error('Usage: node scripts/usage-report.cjs --project ABSOLUTE_PROJECT [--json]'); process.exitCode = 2; }
else {
  const modulePath = path.resolve(__dirname, '..', 'dist', 'usageReport.js');
  if (!fs.existsSync(modulePath)) { console.error(`Missing ${modulePath}; build the extension first.`); process.exitCode = 2; }
  else { Promise.resolve(require(modulePath).generateUsageReport(project)).then(report => { process.stdout.write(process.argv.includes('--json') ? JSON.stringify(report.summary, null, 2) + '\n' : report.markdown); }).catch(error => { console.error(error.message || String(error)); process.exitCode = 1; }); }
}
