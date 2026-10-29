#!/usr/bin/env node
import { serverCli } from './cli.js';

process.exitCode = await serverCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
});
