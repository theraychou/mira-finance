import { readFile } from 'node:fs/promises';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { compactLineItemRows } from '../render-template-fixtures.mjs';
import { repositoryRoot } from '../validate-config.mjs';
import { addressLines, formatAmount, formatDate } from './quotation-renderer.mjs';
import { loadTemplateContract, placeholderTokens, readDocumentXml, resolveInside, setDeterministicZipMetadata, sha256 } from './template-contract.mjs';

function contact(customer) {
  return [customer?.billingContactName, customer?.billingEmail, customer?.billingPhone].filter(Boolean).join(' / ');
}

export async function renderInvoiceDocx({ root = repositoryRoot, snapshot, documentNumber, testMode = false }) {
  if (snapshot.taxMode !== 'NONE' || snapshot.totals.taxMinor !== 0) throw new Error('NON_ZERO_TAX_NOT_RENDERABLE');
  if (snapshot.lineItems.length < 1 || snapshot.lineItems.length > 7) throw new Error('LINE_ITEM_LIMIT_EXCEEDED');
  const { inventory, templateMapping } = await loadTemplateContract(root);
  const template = inventory.templates.find((item) => item.id === snapshot.invoiceTemplateId);
  if (!template || template.documentType !== 'invoice' || template.currency !== snapshot.currency) throw new Error('INVOICE_TEMPLATE_MISMATCH');
  const mapping = templateMapping.currencies[snapshot.currency];
  if (!mapping || mapping.invoiceTemplateId !== template.id || mapping.bankProfileId !== snapshot.bankProfileId) throw new Error('CURRENCY_BANK_TEMPLATE_MISMATCH');
  const input = await readFile(resolveInside(root, template.normalizedPath));
  if (!template.normalizedSha256 || sha256(input) !== template.normalizedSha256) throw new Error('NORMALIZED_TEMPLATE_HASH_MISMATCH');
  const [addressLine1, addressLine2] = addressLines(snapshot.customer?.billingAddress);
  const data = {
    test_banner: testMode ? 'TEST / NOT VALID' : '', document_number: documentNumber,
    issue_date: formatDate(snapshot.issueDate), due_date: formatDate(snapshot.dueDate), valid_until: '',
    customer_name: snapshot.customer?.displayName ?? '', company_name: snapshot.customer?.legalName ?? '',
    address_line_1: addressLine1, address_line_2: addressLine2, customer_contact: contact(snapshot.customer),
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
  const zip = compactLineItemRows(new PizZip(input), snapshot.lineItems.length, template.id);
  const document = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  document.render(data);
  const output = setDeterministicZipMetadata(document.getZip()).generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const { xml } = readDocumentXml(output);
  if (placeholderTokens(xml).length) throw new Error('UNRESOLVED_TEMPLATE_PLACEHOLDER');
  if (!xml.includes(documentNumber) || !xml.includes(data.due_date) || !xml.includes(data.total)) throw new Error('INVOICE_REQUIRED_FIELD_MISSING');
  if (testMode && !xml.includes('TEST / NOT VALID')) throw new Error('TEST_BANNER_MISSING');
  return { buffer: output, data, sha256: sha256(output), templateId: template.id };
}
