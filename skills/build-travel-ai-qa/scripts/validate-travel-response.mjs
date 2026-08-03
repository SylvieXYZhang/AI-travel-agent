#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateTravelResponse } from '../../../lib/validate-travel-response.mjs';

export { validateTravelResponse } from '../../../lib/validate-travel-response.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'));
    const errors = validateTravelResponse(value);
    if (errors.length) {
      console.error(JSON.stringify({ valid: false, errors }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ valid: true }));
    }
  } catch (error) {
    console.error(JSON.stringify({ valid: false, errors: [error.message] }, null, 2));
    process.exitCode = 1;
  }
}
