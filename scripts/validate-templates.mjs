#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
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

function directElements(parent, name) {
  return [...parent.childNodes].filter((node) => node.nodeType === 1 && node.nodeName === name);
}

function ancestor(node, name) {
  let current = node.parentNode;
  while (current) {
    if (current.nodeName === name) return current;
    current = current.parentNode;
  }
  return null;
}

function paragraphText(paragraph) {
  return [...paragraph.getElementsByTagName('w:t')].map((item) => item.textContent ?? '').join('').trim();
}

function paragraphAlignment(paragraph) {
  const properties = directElements(paragraph, 'w:pPr')[0];
  const justification = properties ? directElements(properties, 'w:jc')[0] : undefined;
  return justification?.getAttribute('w:val') ?? '';
}

function paragraphSpacing(paragraph) {
  const properties = directElements(paragraph, 'w:pPr')[0];
  return properties ? directElements(properties, 'w:spacing')[0] : undefined;
}

function validateLayout(xml, template) {
  const templateId = template.id;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const sections = [...document.getElementsByTagName('w:sectPr')];
  if (sections.length === 0) throw new Error(`${templateId}: section properties missing.`);
  for (const section of sections) {
    const pageSize = directElements(section, 'w:pgSz')[0];
    if (!pageSize || pageSize.getAttribute('w:w') !== '11906' || pageSize.getAttribute('w:h') !== '16838') {
      throw new Error(`${templateId}: page size must be A4 portrait.`);
    }
  }

  const descriptionHeader = [...document.getElementsByTagName('w:p')]
    .find((paragraph) => paragraphText(paragraph) === 'DESCRIPTION');
  const lineTable = descriptionHeader ? ancestor(descriptionHeader, 'w:tbl') : undefined;
  const rows = lineTable ? directElements(lineTable, 'w:tr') : [];
  if (rows.length !== 8) throw new Error(`${templateId}: normalized template must retain seven available item rows.`);
  const headerCells = directElements(rows[0], 'w:tc');
  if (paragraphAlignment(directElements(headerCells[2], 'w:p')[0]) !== 'center') {
    throw new Error(`${templateId}: QTY header must be centered.`);
  }
  const expectedAlignments = ['left', 'right', 'center', 'right'];
  for (const row of rows.slice(1)) {
    const cells = directElements(row, 'w:tc');
    for (let index = 0; index < cells.length; index += 1) {
      const paragraph = directElements(cells[index], 'w:p')[0];
      if (paragraphAlignment(paragraph) !== expectedAlignments[index]) {
        throw new Error(`${templateId}: line-item column ${index + 1} alignment is invalid.`);
      }
      const spacing = paragraphSpacing(paragraph);
      if (!spacing || spacing.getAttribute('w:before') !== '40' || spacing.getAttribute('w:after') !== '40') {
        throw new Error(`${templateId}: line-item cell spacing is invalid.`);
      }
    }
  }

  const subtotal = [...document.getElementsByTagName('w:p')]
    .find((paragraph) => paragraphText(paragraph) === 'Subtotal');
  const totalsTable = subtotal ? ancestor(subtotal, 'w:tbl') : undefined;
  if (!totalsTable) throw new Error(`${templateId}: totals table missing.`);
  const totalRows = directElements(totalsTable, 'w:tr');
  for (const row of totalRows) {
    const valueCell = directElements(row, 'w:tc')[1];
    const paragraph = valueCell ? directElements(valueCell, 'w:p')[0] : undefined;
    if (!paragraph || paragraphAlignment(paragraph) !== 'right') {
      throw new Error(`${templateId}: total values must be right aligned.`);
    }
  }
  const finalValueCell = directElements(totalRows.at(-1), 'w:tc')[1];
  const finalValueParagraph = directElements(finalValueCell, 'w:p')[0];
  const colors = [...finalValueParagraph.getElementsByTagName('w:color')]
    .map((color) => color.getAttribute('w:val'));
  if (!colors.includes('FFFFFF')) throw new Error(`${templateId}: final total value must be white.`);

  if (template.documentType === 'invoice') {
    const paymentHeading = [...document.getElementsByTagName('w:p')]
      .find((paragraph) => paragraphText(paragraph) === 'PREFERRED PAYMENT METHOD — BANK TRANSFER');
    const paymentRow = paymentHeading ? ancestor(paymentHeading, 'w:tr') : undefined;
    if (!paymentRow) throw new Error(`${templateId}: payment block missing.`);
    if (paymentRow.getElementsByTagName('w:trHeight').length !== 0) {
      throw new Error(`${templateId}: payment block must not have a fixed row height.`);
    }
    for (const paragraph of [...paymentRow.getElementsByTagName('w:p')]) {
      const heading = paragraphText(paragraph) === 'PREFERRED PAYMENT METHOD — BANK TRANSFER';
      const spacing = paragraphSpacing(paragraph);
      if (!spacing || spacing.getAttribute('w:before') !== '0' || spacing.getAttribute('w:after') !== (heading ? '20' : '0')) {
        throw new Error(`${templateId}: payment block spacing is invalid.`);
      }
      const sizes = [...paragraph.getElementsByTagName('w:sz')]
        .map((size) => Number(size.getAttribute('w:val')));
      if (sizes.some((size) => size > 16)) throw new Error(`${templateId}: payment block text is too large.`);
    }
  }
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
  assertEqual(sha256(normalized), template.normalizedSha256, `${template.id}: normalized template hash changed.`);

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
  validateLayout(normalizedPackage.xml, template);

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
