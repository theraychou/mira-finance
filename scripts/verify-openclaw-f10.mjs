#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenClawF10Patch, loadWhatsAppRoutingConfiguration } from './lib/whatsapp-routing.mjs';

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function withoutManagedPaths(configuration) {
  const copy = structuredClone(configuration);
  delete copy.meta;
  delete copy.bindings;
  if (copy.channels?.whatsapp) delete copy.channels.whatsapp.groups;
  return copy;
}

export function verifyOpenClawF10({ before, current, routing }) {
  const expectedPatch = createOpenClawF10Patch({
    openClawConfiguration: before,
    routingConfiguration: routing
  });
  assert.deepEqual(current.bindings, expectedPatch.bindings, 'Bindings differ from the one-addition F10 patch.');
  const expectedGroups = {
    ...(before.channels?.whatsapp?.groups ?? {}),
    ...expectedPatch.channels.whatsapp.groups
  };
  assert.deepEqual(current.channels?.whatsapp?.groups, expectedGroups, 'WhatsApp groups differ outside RC Finance.');
  assert.deepEqual(
    withoutManagedPaths(current),
    withoutManagedPaths(before),
    'Unrelated OpenClaw configuration changed.'
  );
  return {
    priorBindings: before.bindings?.length ?? 0,
    currentBindings: current.bindings?.length ?? 0,
    priorGroups: Object.keys(before.channels?.whatsapp?.groups ?? {}).length,
    currentGroups: Object.keys(current.channels?.whatsapp?.groups ?? {}).length
  };
}

async function main() {
  const beforePath = value('--before');
  const currentPath = value('--current');
  if (!beforePath || !currentPath) throw new Error('--before and --current are required.');
  const [before, current, routing] = await Promise.all([
    readFile(beforePath, 'utf8').then(JSON.parse),
    readFile(currentPath, 'utf8').then(JSON.parse),
    loadWhatsAppRoutingConfiguration()
  ]);
  const result = verifyOpenClawF10({ before, current, routing });
  console.log(`PASS F10 preserved ${result.priorBindings} prior bindings and ${result.priorGroups} prior groups; one of each added`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL F10 OpenClaw verification failed (${error?.message ?? 'UNKNOWN_ERROR'})`);
    process.exitCode = 1;
  });
}
