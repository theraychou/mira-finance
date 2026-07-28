#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTemplateContract,
  placeholderTokens,
  readDocumentXml,
  requiredPlaceholders,
  resolveInside,
  sha256
} from './lib/template-contract.mjs';
import { repositoryRoot } from './validate-config.mjs';

function packageParts(zip) {
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function validateMappings(contract) {
  const templates = new Map(contract.inventory.templates.map((item) => [item.id, item]));
  const profiles = new Map(contract.bankMapping.profiles.map((item) => [item.id, item]));
  assertEqual(templates.size, 6, 'Template inventory must contain exactly six unique templates.');
  assertEqual(profiles.size, 3, 'Bank mapping must contain exactly three profiles.');

  for (const currency of ['MYR', 'SGD', 'USD']) {
    const mapping = contract.templateMapping.currencies[currency];
    if (!mapping) throw new Error(`Missing template mapping for ${currency}.`);
    const quotation = templates.get(mapping.quotationTemplateId);
    const invoice = templates.get(mapping.invoiceTemplateId);
    const profile = profiles.get(mapping.bankProfileId);
    if (!quotation || quotation.currency !== currency || quotation.documentType !== 'quotation') {
      throw new Error(`Invalid quotation mapping for ${currency}.`);
    }
    if (!invoice || invoice.currency !== currency || invoice.documentType !== 'invoice') {
      throw new Error(`Invalid invoice mapping for ${currency}.`);
    }
    if (!profile || profile.currency !== currency) throw new Error(`Invalid bank mapping for ${currency}.`);
  }
}

async function validateTemplate(root, contract, template) {
  const [source, normalized] = await Promise.all([
    readFile(resolveInside(root, template.sourcePath)),
    readFile(resolveInside(root, template.normalizedPath))
  ]);
  assertEqual(source.length, template.sourceSize, `${template.id}: source size changed.`);
  assertEqual(sha256(source), template.sourceSha256, `${template.id}: protected source hash changed.`);

  const sourcePackage = readDocumentXml(source);
  const normalizedPackage = readDocumentXml(normalized);
  const sourceParts = packageParts(sourcePackage.zip);
  const normalizedParts = packageParts(normalizedPackage.zip);
  assertEqual(JSON.stringify(normalizedParts), JSON.stringify(sourceParts), `${template.id}: package part inventory changed.`);
  for (const part of sourceParts) {
    if (part === 'word/document.xml') continue;
    const before = sourcePackage.zip.file(part).asNodeBuffer();
    const after = normalizedPackage.zip.file(part).asNodeBuffer();
    assertEqual(sha256(after), sha256(before), `${template.id}: preserve-only package part changed: ${part}`);
  }

  const expected = requiredPlaceholders(contract.placeholderMap, template.documentType).sort();
  const actual = placeholderTokens(normalizedPackage.xml);
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), `${template.id}: placeholder contract mismatch.`);
  if (!normalizedPackage.xml.includes('{test_banner}')) throw new Error(`${template.id}: test banner slot missing.`);

  if (template.documentType === 'invoice') {
    const profileId = contract.templateMapping.currencies[template.currency].bankProfileId;
    const profile = contract.bankMapping.profiles.find((item) => item.id === profileId);
    for (const marker of profile.invoiceMarkers) {
      if (!normalizedPackage.xml.includes(marker)) throw new Error(`${template.id}: expected bank marker missing.`);
    }
    const currencyTerms = {
      MYR: 'Malaysian Ringgit (MYR)',
      SGD: 'Singapore Dollars (SGD)',
      USD: 'US Dollars (USD)'
    }[template.currency];
    if (!normalizedPackage.xml.includes(currencyTerms)) throw new Error(`${template.id}: invoice terms use the wrong currency.`);
    if (!normalizedPackage.xml.includes('DUE DATE')) throw new Error(`${template.id}: invoice due-date label missing.`);
  }
}

async function validateOutput(root, contract, template) {
  const outputPath = path.join(root, 'tests', 'generated-output', 'f2', 'docx', `${template.id}-TEST-NOT-VALID.docx`);
  const output = await readFile(outputPath);
  const { xml } = readDocumentXml(output);
  if (placeholderTokens(xml).length > 0) throw new Error(`${template.id}: output has unresolved placeholders.`);
  if (!xml.includes('TEST / NOT VALID')) throw new Error(`${template.id}: output is not visibly marked as test data.`);
  if (!xml.includes('TEST-NOT-VALID')) throw new Error(`${template.id}: output number could be mistaken for an official number.`);
  if (template.documentType === 'invoice') {
    const profileId = contract.templateMapping.currencies[template.currency].bankProfileId;
    const profile = contract.bankMapping.profiles.find((item) => item.id === profileId);
    for (const marker of profile.invoiceMarkers) {
      if (!xml.includes(marker)) throw new Error(`${template.id}: output has the wrong bank profile.`);
    }
  }
}

export async function validateTemplateSet({ root = repositoryRoot, checkOutputs = false } = {}) {
  const contract = await loadTemplateContract(root);
  validateMappings(contract);
  for (const template of contract.inventory.templates) await validateTemplate(root, contract, template);
  if (checkOutputs) {
    for (const template of contract.inventory.templates) await validateOutput(root, contract, template);
  }
  return { ok: true, templates: contract.inventory.templates.length, outputs: checkOutputs ? 6 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateTemplateSet({ checkOutputs: process.argv.includes('--outputs') });
  console.log(`PASS ${result.templates} normalized templates; ${result.outputs} generated outputs checked`);
}
