#!/usr/bin/env node
import path from 'node:path';
import { renderConvertAndFile } from './lib/quotation-renderer.mjs';
import { renderInvoiceDocx } from './lib/invoice-renderer.mjs';
import { loadTemplateContract } from './lib/template-contract.mjs';
import { repositoryRoot } from './validate-config.mjs';

const outputRoot=path.join(repositoryRoot,'tests','generated-output','f7-qa');
const numbers={MYR:'2607291001-MT',SGD:'2607291002-ST',USD:'2607291003-UT'};
const {templateMapping}=await loadTemplateContract(repositoryRoot);
for(const currency of ['MYR','SGD','USD']){
  const mapping=templateMapping.currencies[currency];
  const snapshot={
    kind:'invoice-draft',version:1,quotationId:null,currency,invoiceTemplateId:mapping.invoiceTemplateId,bankProfileId:mapping.bankProfileId,
    issueDate:'2026-07-29',dueDate:'2026-08-28',paymentTermsDays:30,paymentTerms:'TEST terms only',serviceDate:'2026-08-15',purchaseOrderNumber:'TEST-PO-001',
    customer:{id:1,customerCode:'TEST-001',legalName:'Synthetic Customer — TEST / NOT VALID',displayName:'Test Buyer',billingAddress:'Suite 8, Example Business Centre\n88 Fictional Avenue, Test District 50000',billingContactName:'Test Contact',billingEmail:'accounts@example.invalid',billingPhone:'+000 000 0000'},
    businessEntity:{id:1,legalName:'Test Entity — NOT VALID',tradingName:'Test Entity'},notes:'TEST / NOT VALID',sourceChannel:'test',sourceMessageReference:'f7-qa',
    lineItems:[{sequence:1,description:'Synthetic finance service — TEST / NOT VALID',quantity:'1',quantityNumerator:1,quantityScale:1,unit:'lot',unitPriceMinor:150000,subtotalMinor:150000}],
    discount:{type:'NONE',value:0,amountMinor:0},taxMode:'NONE',taxRule:null,
    totals:{subtotalMinor:150000,discountMinor:0,taxMinor:0,totalMinor:150000},validationIssues:[]
  };
  const files=await renderConvertAndFile({root:repositoryRoot,outputRoot,snapshot,documentNumber:numbers[currency],testMode:true,documentRenderer:renderInvoiceDocx});
  console.log(`PASS ${currency} invoice: ${files.pdfRelativePath}; ${files.pageCount} A4 page(s)`);
}
