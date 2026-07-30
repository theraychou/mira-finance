#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './lib/config-validation.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runValidation(root = repositoryRoot) {
  return validateConfig(root);
}

async function main() {
  const result = await runValidation();
  if (result.ok) {
    console.log('PASS foundation configuration is valid');
  } else {
    console.error('FAIL foundation configuration is invalid');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL foundation configuration validation failed (${error?.code ?? 'VALIDATION_ERROR'})`);
    process.exitCode = 1;
  });
}
