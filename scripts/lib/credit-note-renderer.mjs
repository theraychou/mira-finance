import { readFile } from 'node:fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { compactLineItemRows } from '../render-template-fixtures.mjs';
import { repositoryRoot } from '../validate-config.mjs';
import { addressLines, formatAmount, formatDate } from './quotation-renderer.mjs';
import {
  loadTemplateContract, placeholderTokens, readDocumentXml, resolveInside,
  setDeterministicZipMetadata, sha256
} from './template-contract.mjs';

function contact(customer) {
  return [customer?.billingContactName, customer?.billingEmail, customer?.billingPhone].filter(Boolean).join(' / ');
}

function removePaymentTable(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const tables = [...document.getElementsByTagName('w:tbl')];
  for (const table of tables) {
    if (table.textContent.includes('PREFERRED PAYMENT METHOD')) table.parentNode.removeChild(table);
  }
  return new XMLSerializer().serializeToString(document);
}

export async function renderCreditNoteDocx({
  root = repositoryRoot, snapshot, documentNumber, testMode = false
}) {
  if (snapshot.kind !== 'credit-note-draft') throw new Error('CREDIT_NOTE_SNAPSHOT_REQUIRED');
  if (snapshot.lineItems.length < 1 || snapshot.lineItems.length > 7) throw new Error('LINE_ITEM_LIMIT_EXCEEDED');
  const { inventory, templateMapping } = await loadTemplateContract(root);
  const template = inventory.templates.find((item) => item.id === snapshot.invoiceTemplateId);
  if (!template || template.documentType !== 'invoice' || template.currency !== snapshot.currency) {
    throw new Error('CREDIT_NOTE_TEMPLATE_MISMATCH');
  }
  const mapping = templateMapping.currencies[snapshot.currency];
  if (!mapping || mapping.invoiceTemplateId !== template.id || mapping.bankProfileId !== snapshot.bankProfileId) {
    throw new Error('CURRENCY_BANK_TEMPLATE_MISMATCH');
  }
  const input = await readFile(resolveInside(root, template.normalizedPath));
  if (!template.normalizedSha256 || sha256(input) !== template.normalizedSha256) {
    throw new Error('NORMALIZED_TEMPLATE_HASH_MISMATCH');
  }
  const [addressLine1, addressLine2] = addressLines(snapshot.customer.billingAddress);
  const data = {
    test_banner: testMode ? 'TEST / NOT VALID' : '',
    document_number: documentNumber,
    issue_date: formatDate(snapshot.issueDate),
    due_date: 'NOT APPLICABLE',
    valid_until: '',
    customer_name: snapshot.customer.displayName,
    company_name: snapshot.customer.legalName,
    address_line_1: addressLine1,
    address_line_2: addressLine2,
    customer_contact: contact(snapshot.customer),
    subtotal: formatAmount(snapshot.totals.totalMinor, snapshot.currency),
    discount: formatAmount(0, snapshot.currency),
    total: formatAmount(snapshot.totals.totalMinor, snapshot.currency)
  };
  for (let index = 1; index <= 7; index += 1) {
    const line = snapshot.lineItems[index - 1];
    data[`line_${index}_description`] = line?.description ?? '';
    data[`line_${index}_unit_price`] = line
      ? formatAmount(line.amountMinor, snapshot.currency, { includeCurrency: false })
      : '';
    data[`line_${index}_quantity`] = line ? '1' : '';
    data[`line_${index}_total`] = line
      ? formatAmount(line.amountMinor, snapshot.currency, { includeCurrency: false })
      : '';
  }
  const zip = compactLineItemRows(new PizZip(input), snapshot.lineItems.length, template.id);
  const document = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  document.render(data);
  const outputZip = document.getZip();
  let documentXml = outputZip.file('word/document.xml').asText();
  documentXml = removePaymentTable(documentXml)
    .replaceAll('PREFERRED PAYMENT METHOD — BANK TRANSFER', 'CREDIT NOTE — NO PAYMENT REQUIRED')
    .replace(/Payment is due within the validity period stated above\.[^<]*/g,
      `This credit note adjusts original invoice ${snapshot.originalInvoiceNumber}. It is not a request for payment.`)
    .replaceAll('INVOICE NO.', 'CREDIT NOTE NO.')
    .replaceAll('>INVOICE<', '>CREDIT NOTE<');
  outputZip.file('word/document.xml', documentXml);
  const output = setDeterministicZipMetadata(outputZip).generate({
    type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }
  });
  const { xml } = readDocumentXml(output);
  if (placeholderTokens(xml).length) throw new Error('UNRESOLVED_TEMPLATE_PLACEHOLDER');
  if (!xml.includes('CREDIT NOTE') || !xml.includes(documentNumber)
    || !xml.includes(snapshot.originalInvoiceNumber) || !xml.includes(data.total)) {
    throw new Error('CREDIT_NOTE_REQUIRED_FIELD_MISSING');
  }
  if (xml.includes('PREFERRED PAYMENT METHOD') || xml.includes('Payment is due')) {
    throw new Error('CREDIT_NOTE_PAYMENT_INSTRUCTION_PRESENT');
  }
  if (testMode && !xml.includes('TEST / NOT VALID')) throw new Error('TEST_BANNER_MISSING');
  return { buffer: output, data, sha256: sha256(output), templateId: template.id };
}
