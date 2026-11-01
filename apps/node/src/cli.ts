#!/usr/bin/env node
import { run } from './cli/main.js';

run().catch((error) => {
  console.error(`Fatal CLI error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
