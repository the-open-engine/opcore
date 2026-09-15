#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');

Promise.resolve().then(() => run(process.argv.slice(2))).then((status) => {
  process.exitCode = status;
}).catch((error) => {
  process.stderr.write(`opcore: ${error.message}\n`);
  process.exitCode = 1;
});
