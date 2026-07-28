#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
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

export async function renderAll({
  root = repositoryRoot,
  normalizedRoot,
  outputRoot = path.join(repositoryRoot, 'tests', 'generated-output', 'f2', 'docx')
} = {}) {
  const [{ inventory }, fixture] = await Promise.all([
    loadTemplateContract(root),
    readJson(root, 'tests/fixtures/template-render.json')
  ]);
  const results = [];

  for (const template of inventory.templates) {
    const templatePath = normalizedRoot
      ? path.join(normalizedRoot, template.currency.toLowerCase(), `${template.documentType}.docx`)
      : resolveInside(root, template.normalizedPath);
    const input = await readFile(templatePath);
    const data = flattenFixture(fixture, template);
    const doc = new Docxtemplater(new PizZip(input), {
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
  const results = await renderAll();
  for (const result of results) console.log(`RENDERED ${result.id} ${result.sha256}`);
}
