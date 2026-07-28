import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

export async function readJson(root, relativePath) {
  const absolute = resolveInside(root, relativePath);
  return JSON.parse(await readFile(absolute, 'utf8'));
}

export function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Template path escapes the approved workspace.');
  }
  return resolved;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function loadTemplateContract(root) {
  const [inventory, templateMapping, bankMapping, placeholderMap] = await Promise.all([
    readJson(root, 'config/template-inventory.json'),
    readJson(root, 'config/template-mapping.json'),
    readJson(root, 'config/bank-profile-template-mapping.json'),
    readJson(root, 'config/placeholder-map.json')
  ]);
  return { inventory, templateMapping, bankMapping, placeholderMap };
}

export function requiredPlaceholders(placeholderMap, documentType) {
  const result = [...placeholderMap.common];
  result.push(...(documentType === 'quotation' ? placeholderMap.quotationOnly : placeholderMap.invoiceOnly));
  for (let index = 1; index <= placeholderMap.maxLineItems; index += 1) {
    for (const pattern of placeholderMap.lineItemPattern) {
      result.push(pattern.replace('{n}', String(index)));
    }
  }
  return result;
}

export function placeholderTokens(xml) {
  return [...new Set([...xml.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => match[1]))].sort();
}

export function readDocumentXml(buffer) {
  const zip = new PizZip(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('DOCX package is missing word/document.xml.');
  return { zip, xml: file.asText() };
}

export function setDeterministicZipMetadata(zip) {
  for (const entry of Object.values(zip.files)) {
    entry.date = new Date(1980, 0, 1, 0, 0, 0);
  }
  return zip;
}

export function flattenFixture(fixture, template) {
  if (fixture.taxMinor !== 0) throw new Error('Non-zero tax is disabled until an approved tax phase.');
  const amounts = fixture.amounts[template.currency];
  if (!amounts) throw new Error(`Missing synthetic amount display for ${template.currency}.`);

  const data = {
    test_banner: fixture.testBanner,
    document_number: fixture.documentNumber,
    issue_date: fixture.issueDate,
    valid_until: fixture.validUntil,
    due_date: fixture.dueDate,
    customer_name: fixture.customer.name,
    company_name: fixture.customer.companyName,
    address_line_1: fixture.customer.addressLine1,
    address_line_2: fixture.customer.addressLine2,
    customer_contact: fixture.customer.contact,
    subtotal: amounts.subtotal,
    discount: amounts.discount,
    total: amounts.total
  };

  for (let index = 1; index <= 7; index += 1) {
    const line = fixture.lineItems[index - 1] ?? {};
    data[`line_${index}_description`] = line.description ?? '';
    data[`line_${index}_unit_price`] = line.unitPrice ?? '';
    data[`line_${index}_quantity`] = line.quantity ?? '';
    data[`line_${index}_total`] = line.lineTotal ?? '';
  }
  return data;
}

export async function writeAtomic(filePath, buffer, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, buffer, { mode });
  await rename(temporary, filePath);
}
