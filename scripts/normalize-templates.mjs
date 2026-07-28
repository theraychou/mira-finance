#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  loadTemplateContract,
  readDocumentXml,
  resolveInside,
  setDeterministicZipMetadata,
  sha256,
  writeAtomic
} from './lib/template-contract.mjs';
import { repositoryRoot } from './validate-config.mjs';

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

function textNodes(document) {
  return [...document.getElementsByTagName('w:t')];
}

function paragraphText(paragraph) {
  return [...paragraph.getElementsByTagName('w:t')].map((item) => item.textContent ?? '').join('').trim();
}

function findParagraph(document, exact) {
  const matches = [...document.getElementsByTagName('w:p')]
    .filter((paragraph) => paragraphText(paragraph) === exact);
  if (matches.length !== 1) throw new Error(`Expected one paragraph for "${exact}", found ${matches.length}.`);
  return matches[0];
}

function cellText(cell) {
  return [...cell.getElementsByTagName('w:t')].map((node) => node.textContent ?? '').join('');
}

function setElementText(document, element, value) {
  while (element.firstChild) element.removeChild(element.firstChild);
  element.appendChild(document.createTextNode(value));
}

function replaceParagraphText(document, paragraph, value) {
  const nodes = [...paragraph.getElementsByTagName('w:t')];
  if (nodes.length === 0) throw new Error('Cannot replace text in an empty paragraph.');
  setElementText(document, nodes[0], value);
  for (const node of nodes.slice(1)) setElementText(document, node, '');
}

function setCellText(document, cell, value) {
  let paragraph = directElements(cell, 'w:p')[0];
  if (!paragraph) {
    paragraph = document.createElement('w:p');
    cell.appendChild(paragraph);
  }
  for (const child of [...paragraph.childNodes]) {
    if (child.nodeName !== 'w:pPr') paragraph.removeChild(child);
  }
  const run = document.createElement('w:r');
  const text = document.createElement('w:t');
  text.setAttribute('xml:space', 'preserve');
  text.appendChild(document.createTextNode(value));
  run.appendChild(text);
  paragraph.appendChild(run);
}

function appendTestBanner(document, paragraph) {
  const run = document.createElement('w:r');
  const properties = document.createElement('w:rPr');
  const bold = document.createElement('w:b');
  const color = document.createElement('w:color');
  const size = document.createElement('w:sz');
  const sizeCs = document.createElement('w:szCs');
  color.setAttribute('w:val', 'C62828');
  size.setAttribute('w:val', '18');
  sizeCs.setAttribute('w:val', '18');
  properties.appendChild(bold);
  properties.appendChild(color);
  properties.appendChild(size);
  properties.appendChild(sizeCs);
  run.appendChild(properties);
  run.appendChild(document.createElement('w:br'));
  const text = document.createElement('w:t');
  text.appendChild(document.createTextNode('{test_banner}'));
  run.appendChild(text);
  paragraph.appendChild(run);
}

function normalizeDocumentXml(xml, template) {
  const parseErrors = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') parseErrors.push(message);
    }
  }).parseFromString(xml, 'application/xml');
  if (parseErrors.length > 0) throw new Error('Unable to parse template XML.');

  const title = template.documentType === 'quotation' ? 'QUOTATION' : 'INVOICE';
  const titleParagraph = findParagraph(document, title);
  appendTestBanner(document, titleParagraph);

  const titleCell = ancestor(titleParagraph, 'w:tc');
  const metadataTables = [...titleCell.getElementsByTagName('w:tbl')];
  if (metadataTables.length !== 1) throw new Error(`${template.id}: metadata table not found.`);
  const metadataRows = directElements(metadataTables[0], 'w:tr');
  if (metadataRows.length !== 3) throw new Error(`${template.id}: metadata table shape changed.`);
  const metadataPlaceholders = template.documentType === 'quotation'
    ? ['{document_number}', '{issue_date}', '{valid_until}']
    : ['{document_number}', '{issue_date}', '{due_date}'];
  for (let index = 0; index < metadataRows.length; index += 1) {
    const cells = directElements(metadataRows[index], 'w:tc');
    if (cells.length !== 2) throw new Error(`${template.id}: metadata row shape changed.`);
    setCellText(document, cells[1], metadataPlaceholders[index]);
  }
  if (template.documentType === 'invoice') {
    replaceParagraphText(document, findParagraph(document, 'VALID UNTIL'), 'DUE DATE');
  }

  const customerHeading = findParagraph(document, template.documentType === 'quotation' ? 'QUOTE TO' : 'BILL TO');
  const customerCell = ancestor(customerHeading, 'w:tc');
  const customerTables = [...customerCell.getElementsByTagName('w:tbl')];
  if (customerTables.length !== 1) throw new Error(`${template.id}: customer table not found.`);
  const customerRows = directElements(customerTables[0], 'w:tr');
  const customerPlaceholders = [
    '{customer_name}',
    '{company_name}',
    '{address_line_1}',
    '{address_line_2}',
    '{customer_contact}'
  ];
  if (customerRows.length !== customerPlaceholders.length) throw new Error(`${template.id}: customer table shape changed.`);
  for (let index = 0; index < customerRows.length; index += 1) {
    const cells = directElements(customerRows[index], 'w:tc');
    setCellText(document, cells[0], customerPlaceholders[index]);
  }

  const descriptionHeader = findParagraph(document, 'DESCRIPTION');
  const lineTable = ancestor(descriptionHeader, 'w:tbl');
  const lineRows = directElements(lineTable, 'w:tr');
  if (lineRows.length !== 8) throw new Error(`${template.id}: expected seven line-item rows.`);
  for (let rowIndex = 1; rowIndex < lineRows.length; rowIndex += 1) {
    const cells = directElements(lineRows[rowIndex], 'w:tc');
    if (cells.length !== 4) throw new Error(`${template.id}: line-item row shape changed.`);
    const fields = ['description', 'unit_price', 'quantity', 'total'];
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      setCellText(document, cells[cellIndex], `{line_${rowIndex}_${fields[cellIndex]}}`);
    }
  }

  const subtotalLabel = findParagraph(document, 'Subtotal');
  const totalsTable = ancestor(subtotalLabel, 'w:tbl');
  const totalRows = directElements(totalsTable, 'w:tr');
  const totalFields = ['{subtotal}', '{discount}', '{total}'];
  if (totalRows.length !== totalFields.length) throw new Error(`${template.id}: totals table shape changed.`);
  for (let index = 0; index < totalRows.length; index += 1) {
    const cells = directElements(totalRows[index], 'w:tc');
    setCellText(document, cells[1], totalFields[index]);
  }

  for (const node of textNodes(document)) {
    if (template.documentType === 'invoice' && (node.textContent ?? '').includes('Amounts are in Malaysian Ringgit (MYR)')) {
      const currencyName = {
        MYR: 'Malaysian Ringgit (MYR)',
        SGD: 'Singapore Dollars (SGD)',
        USD: 'US Dollars (USD)'
      }[template.currency];
      setElementText(document, node, node.textContent.replace('Malaysian Ringgit (MYR)', currencyName));
    }
  }

  if (template.currency === 'MYR' && template.documentType === 'quotation') {
    replaceParagraphText(document, findParagraph(document, 'TOTAL (RM)'), 'TOTAL (MYR)');
  }

  if (!cellText(lineTable).includes('{line_7_total}')) throw new Error(`${template.id}: line-item placeholders were not inserted.`);
  return new XMLSerializer().serializeToString(document);
}

export async function normalizeAll({ root = repositoryRoot, outputRoot } = {}) {
  const { inventory } = await loadTemplateContract(root);
  const results = [];
  for (const template of inventory.templates) {
    const sourcePath = resolveInside(root, template.sourcePath);
    const source = await readFile(sourcePath);
    if (source.length !== template.sourceSize || sha256(source) !== template.sourceSha256) {
      throw new Error(`${template.id}: protected source hash or size mismatch.`);
    }
    const { zip, xml } = readDocumentXml(source);
    zip.file('word/document.xml', normalizeDocumentXml(xml, template));
    const output = setDeterministicZipMetadata(zip).generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    const outputPath = outputRoot
      ? path.join(outputRoot, template.currency.toLowerCase(), `${template.documentType}.docx`)
      : resolveInside(root, template.normalizedPath);
    await writeAtomic(outputPath, output);
    results.push({ id: template.id, path: outputPath, sha256: sha256(output) });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await normalizeAll();
  for (const result of results) console.log(`NORMALIZED ${result.id} ${result.sha256}`);
}
