import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { createQuotationDraft } from '../../scripts/lib/quotation-drafts.mjs';
import { calculateDueDate, createInvoiceConfirmationToken, createInvoiceDraftFromQuotation, createStandaloneInvoiceDraft } from '../../scripts/lib/invoice-drafts.mjs';
import { renderInvoiceDocx } from '../../scripts/lib/invoice-renderer.mjs';
import { issueConfirmedInvoice } from '../../scripts/lib/invoice-issuance.mjs';
import { confirmPaymentStatus, createPaymentStatusDraft } from '../../scripts/lib/invoice-payments.mjs';
import { readDocumentXml } from '../../scripts/lib/template-contract.mjs';

const NOW='2026-07-29T00:00:00.000Z';
async function fixture({purchaseOrderRequired=0}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'mira-f7-')),databasePath=path.join(directory,'finance.sqlite3'),outputRoot=path.join(directory,'output');
  await migrateUp({databasePath,now:()=>NOW});const db=openDatabase(databasePath);
  const entityId=Number(db.prepare("INSERT INTO business_entities (legal_name,trading_name,default_currency,active,created_at,updated_at) VALUES ('TEST Entity — NOT VALID','TEST Entity','MYR',1,?,?)").run(NOW,NOW).lastInsertRowid);
  const customerId=Number(db.prepare(`INSERT INTO customers
    (customer_code,legal_name,display_name,billing_address,billing_contact_name,billing_email,billing_phone,default_currency,default_payment_terms_days,purchase_order_required,active,created_at,updated_at)
    VALUES ('TEST-F7','Synthetic Customer — TEST / NOT VALID','Synthetic Customer','TEST ADDRESS — NOT VALID','TEST Contact','accounts@example.invalid','+000000000','MYR',30,?,1,?,?)`).run(purchaseOrderRequired,NOW,NOW).lastInsertRowid);
  db.prepare(`INSERT INTO bank_profiles (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at)
    VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST BANK','TEST ACCOUNT','0000000000',1,?,?)`).run(entityId,NOW,NOW);
  db.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run();db.close();
  return{directory,databasePath,outputRoot,entityId,customerId};
}
function input(ids,changes={}){return{customer_id:ids.customerId,business_entity_id:ids.entityId,currency:'MYR',issue_date:'2026-07-29',payment_terms_days:30,service_date:'2026-08-15',purchase_order_number:'TEST-PO-001',payment_terms:'30 days — TEST ONLY',notes:'TEST / NOT VALID',source_channel:'test',source_message_reference:'f7-test',line_items:[{description:'Synthetic service — TEST / NOT VALID',quantity:'1',unit:'lot',unit_price_minor:10000}],discount:{type:'NONE'},tax:{mode:'NONE'},...changes};}
async function cleanup(ids){const db=openDatabase(ids.databasePath);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec('PRAGMA journal_mode=DELETE');db.close();await rm(ids.directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
async function fakePdfConverter({pdfPath}){await writeFile(pdfPath,Buffer.from('%PDF-1.4\n2607291001-SC RM 100.00 TEST / NOT VALID\n%%EOF'),{mode:0o600});}
async function fakePdfInspector({pdfPath}){return{pageCount:1,a4:true,text:await readFile(pdfPath,'utf8')};}

test('standalone invoice calculates due date, records PO, renders deterministically, and issues only after confirmation',async()=>{
  const ids=await fixture({purchaseOrderRequired:1});try{
    assert.equal(calculateDueDate('2026-01-31',30),'2026-03-02');assert.equal(calculateDueDate('2026-07-29',0),'2026-07-29');
    const draft=createStandaloneInvoiceDraft({databasePath:ids.databasePath,input:input(ids),actor:'test-user',now:'2026-07-29T00:01:00.000Z'});
    assert.equal(draft.snapshot.dueDate,'2026-08-28');assert.equal(draft.snapshot.purchaseOrderNumber,'TEST-PO-001');assert.deepEqual(draft.snapshot.validationIssues,[]);
    const first=await renderInvoiceDocx({snapshot:draft.snapshot,documentNumber:'2607291001-SC',testMode:true});
    const second=await renderInvoiceDocx({snapshot:draft.snapshot,documentNumber:'2607291001-SC',testMode:true});assert.equal(first.sha256,second.sha256);
    const xml=readDocumentXml(first.buffer).xml;assert.ok(xml.includes('TEST / NOT VALID'));assert.ok(xml.includes('28 August 2026'));
    await createInvoiceConfirmationToken({databasePath:ids.databasePath,invoiceId:draft.id,requestingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',tokenFactory:()=> 'ID-CCCCCCCCCC',now:'2026-07-29T00:02:00.000Z'});
    const issued=await issueConfirmedInvoice({databasePath:ids.databasePath,token:'ID-CCCCCCCCCC',confirmingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',clientInitials:'SC',outputRoot:ids.outputRoot,testMode:true,pdfConverter:fakePdfConverter,pdfInspector:fakePdfInspector,now:'2026-07-29T00:03:00.000Z'});
    assert.equal(issued.invoice_status,'ISSUED');assert.equal(issued.invoice_number,'2607291001-SC');assert.equal(issued.balance_due_minor,10000);
    await assert.rejects(issueConfirmedInvoice({databasePath:ids.databasePath,token:'ID-CCCCCCCCCC',confirmingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',clientInitials:'SC'}),/CONFIRMATION_TOKEN_NOT_PENDING/);
  }finally{await cleanup(ids);}
});

test('invoice-from-quotation is full-only and duplicate conversion returns a warning',async()=>{
  const ids=await fixture();try{
    const quotation=createQuotationDraft({databasePath:ids.databasePath,input:{customer_id:ids.customerId,business_entity_id:ids.entityId,currency:'MYR',issue_date:'2026-07-29',validity_days:30,service_date:'2026-08-15',title:'TEST / NOT VALID',description:'Synthetic',payment_terms:'30 days',notes:'TEST / NOT VALID',line_items:input(ids).line_items,discount:{type:'NONE'},tax:{mode:'NONE'}},actor:'test-user',now:'2026-07-29T00:01:00.000Z'});
    const db=openDatabase(ids.databasePath);db.prepare("UPDATE quotations SET status='ISSUED',quotation_number='2607291001-SC',issued_at=? WHERE id=?").run('2026-07-29T00:02:00.000Z',quotation.id);db.close();
    const converted=createInvoiceDraftFromQuotation({databasePath:ids.databasePath,quotationId:quotation.id,issueDate:'2026-07-30',paymentTermsDays:30,paymentTerms:'30 days',purchaseOrderNumber:null,actor:'test-user',now:'2026-07-29T00:03:00.000Z'});
    assert.equal(converted.snapshot.quotationId,quotation.id);assert.equal(converted.snapshot.totals.totalMinor,quotation.snapshot.totals.totalMinor);
    const duplicate=createInvoiceDraftFromQuotation({databasePath:ids.databasePath,quotationId:quotation.id,issueDate:'2026-07-30',paymentTermsDays:30,paymentTerms:'30 days',actor:'test-user'});assert.equal(duplicate.status,'DUPLICATE_WARNING');
    assert.throws(()=>createInvoiceDraftFromQuotation({databasePath:ids.databasePath,quotationId:quotation.id,issueDate:'2026-07-30',paymentTermsDays:30,paymentTerms:'30 days',actor:'test-user',partial:true}),/PARTIAL_INVOICING_NOT_SUPPORTED_F7/);
  }finally{await cleanup(ids);}
});

test('partial and full payments require confirmation; overpayment is blocked and audit history is immutable',async()=>{
  const ids=await fixture();try{
    const draft=createStandaloneInvoiceDraft({databasePath:ids.databasePath,input:input(ids),actor:'test-user',now:'2026-07-29T00:01:00.000Z'});
    const db=openDatabase(ids.databasePath);db.prepare("UPDATE invoices SET status='ISSUED',invoice_number='2607291001-SC',issued_at=? WHERE id=?").run('2026-07-29T00:02:00.000Z',draft.id);db.close();
    assert.throws(()=>createPaymentStatusDraft({databasePath:ids.databasePath,invoiceId:draft.id,amountMinor:10001,paymentDate:'2026-07-29',requestingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat'}),/OVERPAYMENT_BLOCKED/);
    createPaymentStatusDraft({databasePath:ids.databasePath,invoiceId:draft.id,amountMinor:4000,paymentDate:'2026-07-29',paymentReference:'TEST-REF-1',requestingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',tokenFactory:()=> 'PM-CCCCCCCCCC',now:'2026-07-29T00:03:00.000Z'});
    const partial=confirmPaymentStatus({databasePath:ids.databasePath,token:'PM-CCCCCCCCCC',confirmingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',now:'2026-07-29T00:04:00.000Z'});assert.equal(partial.paymentStatus,'PARTIALLY_PAID');assert.equal(partial.balanceDueMinor,6000);assert.equal(partial.paidAt,null);
    createPaymentStatusDraft({databasePath:ids.databasePath,invoiceId:draft.id,amountMinor:6000,paymentDate:'2026-07-30',requestingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',tokenFactory:()=> 'PM-DDDDDDDDDD',now:'2026-07-29T00:05:00.000Z'});
    const paid=confirmPaymentStatus({databasePath:ids.databasePath,token:'PM-DDDDDDDDDD',confirmingUser:'test-user',sourceChannel:'test',sourceChat:'test-chat',now:'2026-07-29T00:06:00.000Z'});assert.equal(paid.paymentStatus,'PAID');assert.equal(paid.balanceDueMinor,0);assert.equal(paid.paidAt,'2026-07-30');
    const ledger=openDatabase(ids.databasePath);assert.equal(ledger.prepare('SELECT COUNT(*) AS count FROM invoice_payment_events WHERE invoice_id=?').get(draft.id).count,2);assert.throws(()=>ledger.prepare('UPDATE invoice_payment_events SET amount_minor=1 WHERE invoice_id=?').run(draft.id),/append-only/);ledger.close();
  }finally{await cleanup(ids);}
});
