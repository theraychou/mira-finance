import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { compactLineItemRows } from '../render-template-fixtures.mjs';
import {
  loadTemplateContract,
  placeholderTokens,
  readDocumentXml,
  resolveInside,
  setDeterministicZipMetadata,
  sha256
} from './template-contract.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const execFileAsync = promisify(execFile);
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function formatDate(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateText) throw new TypeError('Document date is invalid.');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatAmount(amountMinor, currency, { includeCurrency = true } = {}) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new TypeError('Amount must be a non-negative safe integer.');
  const digits = String(amountMinor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const value = `${whole}.${digits.slice(-2)}`;
  if (!includeCurrency) return value;
  const prefixes = { MYR: 'RM', SGD: 'SGD', USD: 'USD' };
  if (!prefixes[currency]) throw new TypeError(`Unsupported currency: ${currency}.`);
  return `${prefixes[currency]} ${value}`;
}

export function addressLines(value) {
  const lines = String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 2) return [lines[0] ?? '', lines[1] ?? ''];
  return [lines[0], lines.slice(1).join(', ')];
}

function renderData(snapshot, documentNumber, testMode) {
  if (snapshot.taxMode !== 'NONE' || snapshot.totals.taxMinor !== 0) {
    throw new Error('NON_ZERO_TAX_NOT_RENDERABLE');
  }
  if (snapshot.lineItems.length < 1 || snapshot.lineItems.length > 7) throw new Error('LINE_ITEM_LIMIT_EXCEEDED');
  const [addressLine1, addressLine2] = addressLines(snapshot.customer?.billingAddress);
  const data = {
    test_banner: testMode ? 'TEST / NOT VALID' : '',
    document_number: documentNumber,
    issue_date: formatDate(snapshot.issueDate),
    valid_until: formatDate(snapshot.validUntil),
    customer_name: snapshot.customer?.displayName ?? '',
    company_name: snapshot.customer?.legalName ?? '',
    address_line_1: addressLine1,
    address_line_2: addressLine2,
    customer_contact: '',
    subtotal: formatAmount(snapshot.totals.subtotalMinor, snapshot.currency),
    discount: formatAmount(snapshot.totals.discountMinor, snapshot.currency),
    total: formatAmount(snapshot.totals.totalMinor, snapshot.currency)
  };
  for (let index = 1; index <= 7; index += 1) {
    const line = snapshot.lineItems[index - 1];
    data[`line_${index}_description`] = line?.description ?? '';
    data[`line_${index}_unit_price`] = line ? formatAmount(line.unitPriceMinor, snapshot.currency, { includeCurrency: false }) : '';
    data[`line_${index}_quantity`] = line?.quantity ?? '';
    data[`line_${index}_total`] = line ? formatAmount(line.subtotalMinor, snapshot.currency, { includeCurrency: false }) : '';
  }
  return data;
}

export async function renderQuotationDocx({
  root = repositoryRoot, snapshot, documentNumber, testMode = false
}) {
  const { inventory, templateMapping } = await loadTemplateContract(root);
  const template = inventory.templates.find((item) => item.id === snapshot.quotationTemplateId);
  if (!template || template.documentType !== 'quotation' || template.currency !== snapshot.currency) {
    throw new Error('QUOTATION_TEMPLATE_MISMATCH');
  }
  const mapping = templateMapping.currencies[snapshot.currency];
  if (!mapping || mapping.quotationTemplateId !== template.id || mapping.bankProfileId !== snapshot.bankProfileId) {
    throw new Error('CURRENCY_BANK_TEMPLATE_MISMATCH');
  }
  const templatePath = resolveInside(root, template.normalizedPath);
  const input = await readFile(templatePath);
  if (!template.normalizedSha256 || sha256(input) !== template.normalizedSha256) throw new Error('NORMALIZED_TEMPLATE_HASH_MISMATCH');
  const data = renderData(snapshot, documentNumber, testMode);
  const zip = compactLineItemRows(new PizZip(input), snapshot.lineItems.length, template.id);
  const document = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  document.render(data);
  const output = setDeterministicZipMetadata(document.getZip()).generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  const { xml } = readDocumentXml(output);
  if (placeholderTokens(xml).length > 0) throw new Error('UNRESOLVED_TEMPLATE_PLACEHOLDER');
  if (!xml.includes(documentNumber)) throw new Error('DOCUMENT_NUMBER_MISSING_FROM_DOCX');
  if (!xml.includes(data.total)) throw new Error('TOTAL_MISSING_FROM_DOCX');
  if (testMode && !xml.includes('TEST / NOT VALID')) throw new Error('TEST_BANNER_MISSING');
  return { buffer: output, data, sha256: sha256(output), templateId: template.id };
}

export async function convertDocxToPdf({
  docxPath, pdfPath, sofficeCommand = 'soffice', timeoutMs = 120000
}) {
  const profile = await mkdtemp(path.join(path.dirname(docxPath), '.lo-profile-'));
  try {
    await execFileAsync(sofficeCommand, [
      '--headless', `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to', 'pdf', '--outdir', path.dirname(pdfPath), docxPath
    ], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: profile }
    });
    const produced = path.join(path.dirname(pdfPath), `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
    if (path.resolve(produced) !== path.resolve(pdfPath)) await rename(produced, pdfPath);
    const normalized = normalizePdfDeterminism(await readFile(pdfPath));
    await writeFile(pdfPath, normalized, { flag: 'w', mode: 0o600 });
    await chmod(pdfPath, 0o600);
    return pdfPath;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

export function normalizePdfDeterminism(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('INVALID_PDF_STRUCTURE');
  let text = buffer.toString('latin1');
  let dateCount = 0;
  let idCount = 0;
  let checksumCount = 0;
  text = text.replace(/\/CreationDate\(D:\d{14}[+-]\d{2}'\d{2}'\)/g, () => {
    dateCount += 1;
    return "/CreationDate(D:19800101000000+00'00')";
  });
  text = text.replace(/\/ID \[ <[0-9A-Fa-f]{32}>\s*<[0-9A-Fa-f]{32}> \]/g, (match) => {
    idCount += 1;
    return match.replace(/[0-9A-Fa-f]{32}/g, '00000000000000000000000000000000');
  });
  text = text.replace(/\/DocChecksum \/[0-9A-Fa-f]{32}/g, () => {
    checksumCount += 1;
    return '/DocChecksum /00000000000000000000000000000000';
  });
  if (dateCount < 1 || idCount !== 1 || checksumCount !== 1) throw new Error('PDF_DETERMINISM_FIELDS_MISSING');
  const digest = createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex').slice(0, 32).toUpperCase();
  text = text
    .replace(/\/ID \[ <0{32}>(\s*)<0{32}> \]/, `/ID [ <${digest}>$1<${digest}> ]`)
    .replace(/\/DocChecksum \/0{32}/, `/DocChecksum /${digest}`);
  return Buffer.from(text, 'latin1');
}

export async function inspectPdf({ pdfPath, pdfinfoCommand = 'pdfinfo', pdftotextCommand = 'pdftotext' }) {
  const [{ stdout: information }, { stdout: text }] = await Promise.all([
    execFileAsync(pdfinfoCommand, [pdfPath], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 }),
    execFileAsync(pdftotextCommand, [pdfPath, '-'], { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  ]);
  const pages = /^Pages:\s+(\d+)$/mi.exec(information)?.[1];
  return {
    pageCount: pages ? Number(pages) : 0,
    a4: /^Page size:.*\(A4\)/mi.test(information),
    text
  };
}

export function validateIssuedOutputs({ docxBuffer, pdfBuffer, pdfInspection, snapshot, documentNumber, testMode }) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-')) || !pdfBuffer.includes(Buffer.from('%%EOF'))) {
    throw new Error('INVALID_PDF_STRUCTURE');
  }
  const { xml } = readDocumentXml(docxBuffer);
  const expectedTotal = formatAmount(snapshot.totals.totalMinor, snapshot.currency);
  if (!xml.includes(documentNumber) || !xml.includes(expectedTotal)) throw new Error('DOCX_TOTAL_OR_NUMBER_MISMATCH');
  if (testMode && !xml.includes('TEST / NOT VALID')) throw new Error('TEST_BANNER_MISSING');
  const pdfText = String(pdfInspection?.text ?? '').replaceAll(/\s+/g, ' ').trim();
  if (!pdfInspection || pdfInspection.pageCount < 1 || !pdfInspection.a4) throw new Error('PDF_PAGE_VALIDATION_FAILED');
  if (!pdfText.includes(documentNumber)) throw new Error('DOCUMENT_NUMBER_MISSING_FROM_PDF');
  const compactTotal = expectedTotal.replaceAll(/\s+/g, '');
  if (!pdfText.replaceAll(/\s+/g, '').includes(compactTotal)) throw new Error('TOTAL_MISSING_FROM_PDF');
  if (testMode && !pdfText.includes('TEST / NOT VALID')) throw new Error('TEST_BANNER_MISSING_FROM_PDF');
  return { docxSha256: sha256(docxBuffer), pdfSha256: sha256(pdfBuffer), pageCount: pdfInspection.pageCount };
}

export async function publishImmutableBuffer(filePath, buffer) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`;
  let linked = false;
  try {
    await writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    await link(temporary, filePath);
    linked = true;
    await chmod(filePath, 0o600);
  } catch (error) {
    if (linked) await rm(filePath, { force: true });
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return filePath;
}

export async function renderConvertAndFile({
  root = repositoryRoot, outputRoot = path.join(repositoryRoot, 'generated', 'quotations'),
  snapshot, documentNumber, testMode = false,
  documentRenderer = renderQuotationDocx,
  pdfConverter = convertDocxToPdf,
  pdfInspector = inspectPdf
}) {
  const resolvedOutputRoot = path.resolve(outputRoot);
  await mkdir(resolvedOutputRoot, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(resolvedOutputRoot, '.staging-'));
  const relativeDirectory = path.join(snapshot.issueDate.slice(0, 4), snapshot.issueDate.slice(5, 7));
  const docxRelativePath = path.join(relativeDirectory, `${documentNumber}.docx`);
  const pdfRelativePath = path.join(relativeDirectory, `${documentNumber}.pdf`);
  const finalDocx = path.join(resolvedOutputRoot, docxRelativePath);
  const finalPdf = path.join(resolvedOutputRoot, pdfRelativePath);
  const stagedDocx = path.join(staging, 'quotation.docx');
  const stagedPdf = path.join(staging, 'quotation.pdf');
  const published = [];
  try {
    const rendered = await documentRenderer({ root, snapshot, documentNumber, testMode });
    await writeFile(stagedDocx, rendered.buffer, { flag: 'wx', mode: 0o600 });
    await pdfConverter({ docxPath: stagedDocx, pdfPath: stagedPdf });
    const [pdfBuffer, inspection] = await Promise.all([readFile(stagedPdf), pdfInspector({ pdfPath: stagedPdf })]);
    const validation = validateIssuedOutputs({
      docxBuffer: rendered.buffer, pdfBuffer, pdfInspection: inspection,
      snapshot, documentNumber, testMode
    });
    await publishImmutableBuffer(finalDocx, rendered.buffer);
    published.push(finalDocx);
    await publishImmutableBuffer(finalPdf, pdfBuffer);
    published.push(finalPdf);
    return {
      ...validation,
      docxRelativePath: docxRelativePath.split(path.sep).join('/'),
      pdfRelativePath: pdfRelativePath.split(path.sep).join('/'),
      docxPath: finalDocx,
      pdfPath: finalPdf
    };
  } catch (error) {
    for (const candidate of published.reverse()) await rm(candidate, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
