#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './validate-config.mjs';
import {
  createOpenClawF10Patch,
  createWhatsAppRoutingConfiguration,
  writePrivateJson
} from './lib/whatsapp-routing.mjs';
import { validateValueAgainstSchema } from './lib/config-validation.mjs';

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function configureWhatsAppRouting({
  groupId,
  authorizedSender,
  openClawConfigPath,
  routingPath = path.join(repositoryRoot, 'config', 'whatsapp-routing.json'),
  patchPath = path.join(repositoryRoot, 'config', 'openclaw-f10.patch.local.json')
}) {
  const routing = createWhatsAppRoutingConfiguration({ groupId, authorizedSender });
  const validation = await validateValueAgainstSchema(repositoryRoot, 'schemas/whatsapp-routing.schema.json', routing);
  if (!validation.ok) throw new Error('Generated WhatsApp routing configuration failed validation.');
  const openClawConfiguration = JSON.parse(await readFile(openClawConfigPath, 'utf8'));
  const patch = createOpenClawF10Patch({ openClawConfiguration, routingConfiguration: routing });
  await writePrivateJson(routingPath, routing);
  await writePrivateJson(patchPath, patch);
  return { routingPath, patchPath, priorBindingCount: openClawConfiguration.bindings?.length ?? 0 };
}

async function main() {
  if (!process.argv.includes('--admin')) throw new Error('F10 configuration requires explicit --admin mode.');
  const result = await configureWhatsAppRouting({
    groupId: value('--group-id'),
    authorizedSender: value('--authorized-sender'),
    openClawConfigPath: value('--openclaw-config')
  });
  console.log(`PASS private F10 routing files prepared; prior bindings: ${result.priorBindingCount}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL F10 routing configuration was not prepared (${error?.message ?? 'UNKNOWN_ERROR'})`);
    process.exitCode = 1;
  });
}
