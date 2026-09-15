#!/usr/bin/env node
'use strict';

const { install } = require('./lib/setup');

install().then(() => {
  process.stdout.write('Opcore setup complete. Run opcore doctor from your Git project.\n');
}).catch((error) => {
  process.stderr.write(`opcore install failed: ${error.message}\n`);
  process.exitCode = 1;
});
