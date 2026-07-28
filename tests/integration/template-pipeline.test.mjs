import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeAll } from '../../scripts/normalize-templates.mjs';
import { renderAll } from '../../scripts/render-template-fixtures.mjs';
import { placeholderTokens, readDocumentXml } from '../../scripts/lib/template-contract.mjs';

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

test('normalization is deterministic and synthetic rendering resolves every placeholder', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mira-f2-'));
  try {
    const firstRoot = path.join(temporary, 'normalized-a');
    const secondRoot = path.join(temporary, 'normalized-b');
    const outputs = path.join(temporary, 'outputs');
    const first = await normalizeAll({ outputRoot: firstRoot });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await normalizeAll({ outputRoot: secondRoot });
    assert.deepEqual(first.map((item) => item.sha256), second.map((item) => item.sha256));

    const rendered = await renderAll({ normalizedRoot: firstRoot, outputRoot: outputs });
    const renderedAgain = await renderAll({ normalizedRoot: secondRoot, outputRoot: path.join(temporary, 'outputs-again') });
    assert.deepEqual(rendered.map((item) => item.sha256), renderedAgain.map((item) => item.sha256));
    assert.equal(rendered.length, 6);
    for (const artifact of rendered) {
      const { xml } = readDocumentXml(await readFile(artifact.path));
      assert.deepEqual(placeholderTokens(xml), []);
      assert.match(xml, /TEST \/ NOT VALID/);
      assert.match(xml, /TEST-NOT-VALID/);
    }

    const sample = await renderAll({
      normalizedRoot: firstRoot,
      outputRoot: path.join(temporary, 'sample'),
      fixturePath: 'tests/fixtures/sample-myr-invoice.json',
      templateIds: ['invoice-myr']
    });
    assert.equal(sample.length, 1);
    const { xml: sampleXml } = readDocumentXml(await readFile(sample[0].path));
    const document = new DOMParser().parseFromString(sampleXml, 'application/xml');
    const descriptionHeader = [...document.getElementsByTagName('w:p')]
      .find((paragraph) => paragraphText(paragraph) === 'DESCRIPTION');
    const rows = directElements(ancestor(descriptionHeader, 'w:tbl'), 'w:tr');
    assert.equal(rows.length, 3, 'two-item sample should contain one header and two item rows');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
