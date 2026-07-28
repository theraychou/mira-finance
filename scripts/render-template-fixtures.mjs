#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  flattenFixture,
  loadTemplateContract,
  placeholderTokens,
  readDocumentXml,
  readJson,
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

function paragraphText(paragraph) {
  return [...paragraph.getElementsByTagName('w:t')].map((item) => item.textContent ?? '').join('').trim();
}

function compactLineItemRows(zip, itemCount, templateId) {
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 7) {
    throw new Error(`${templateId}: line-item count must be between 1 and 7.`);
  }
  const file = zip.file('word/document.xml');
  if (!file) throw new Error(`${templateId}: DOCX package is missing word/document.xml.`);
  const parseErrors = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') parseErrors.push(message);
    }
  }).parseFromString(file.asText(), 'application/xml');
  if (parseErrors.length > 0) throw new Error(`${templateId}: unable to parse normalized template XML.`);

  const descriptionHeaders = [...document.getElementsByTagName('w:p')]
    .filter((paragraph) => paragraphText(paragraph) === 'DESCRIPTION');
  if (descriptionHeaders.length !== 1) throw new Error(`${templateId}: line-item table header not found.`);
  const table = ancestor(descriptionHeaders[0], 'w:tbl');
  const rows = directElements(table, 'w:tr');
  if (rows.length !== 8) throw new Error(`${templateId}: expected seven available line-item rows.`);
  for (let index = rows.length - 1; index > itemCount; index -= 1) table.removeChild(rows[index]);
  zip.file('word/document.xml', new XMLSerializer().serializeToString(document));
  return zip;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function renderAll({
  root = repositoryRoot,
  normalizedRoot,
  outputRoot = path.join(repositoryRoot, 'tests', 'generated-output', 'f2', 'docx'),
  fixturePath = 'tests/fixtures/template-render.json',
  templateIds
} = {}) {
  const [{ inventory }, fixture] = await Promise.all([
    loadTemplateContract(root),
    readJson(root, fixturePath)
  ]);
  const results = [];
  const templates = templateIds
    ? inventory.templates.filter((template) => templateIds.includes(template.id))
    : inventory.templates;
  if (templateIds && templates.length !== templateIds.length) throw new Error('Unknown template ID requested.');

  for (const template of templates) {
    const templatePath = normalizedRoot
      ? path.join(normalizedRoot, template.currency.toLowerCase(), `${template.documentType}.docx`)
      : resolveInside(root, template.normalizedPath);
    const input = await readFile(templatePath);
    const data = flattenFixture(fixture, template);
    const zip = compactLineItemRows(new PizZip(input), fixture.lineItems.length, template.id);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => ''
    });
    doc.render(data);
    const output = setDeterministicZipMetadata(doc.getZip()).generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    const { xml } = readDocumentXml(output);
    const unresolved = placeholderTokens(xml);
    if (unresolved.length > 0) throw new Error(`${template.id}: unresolved placeholders remain.`);
    if (!xml.includes(fixture.testBanner)) throw new Error(`${template.id}: TEST / NOT VALID banner is missing.`);

    const outputPath = path.join(outputRoot, `${template.id}-TEST-NOT-VALID.docx`);
    await writeAtomic(outputPath, output);
    results.push({ id: template.id, path: outputPath, sha256: sha256(output) });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixturePath = argumentValue('--fixture') ?? 'tests/fixtures/template-render.json';
  const templateId = argumentValue('--template');
  const outputArgument = argumentValue('--output-root');
  const outputRoot = outputArgument ? resolveInside(repositoryRoot, outputArgument) : undefined;
  const results = await renderAll({
    fixturePath,
    templateIds: templateId ? [templateId] : undefined,
    outputRoot
  });
  for (const result of results) console.log(`RENDERED ${result.id} ${result.sha256}`);
}
