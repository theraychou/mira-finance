import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { createStandaloneInvoiceDraft,createInvoiceConfirmationToken } from '../../scripts/lib/invoice-drafts.mjs';
import { issueConfirmedInvoice } from '../../scripts/lib/invoice-issuance.mjs';
import { renderInvoiceDocx } from '../../scripts/lib/invoice-renderer.mjs';

const NOW='2026-09-12T00:00:00.000Z',ROOT='TEST_ROOT_FOLDER_ID',NUMBER='2609121001-TD';
function fakeDrive(){
  const items=new Map([[ROOT,{id:ROOT,name:'rc_finance',mimeType:'application/vnd.google-apps.folder',parents:[]}]]);let sequence=0;
  return {items,
    async findByName({name,parentId}){return [...items.values()].filter((item)=>item.name===name&&item.parents.includes(parentId));},
    async createFolder({name,parentId}){const value={id:`TEST_FOLDER_${++sequence}`,name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]};items.set(value.id,value);return value;},
    async uploadFile({localPath,name,parentId}){const bytes=await readFile(localPath);const value={id:`TEST_FILE_${++sequence}`,name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',parents:[parentId],size:bytes.length,md5Checksum:createHash('md5').update(bytes).digest('hex'),bytes};items.set(value.id,value);return value;},
    async getMetadata(id){const value=items.get(id);if(!value)throw new Error('DRIVE_ITEM_NOT_FOUND');return value;}
  };
}
async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'mira-f20-')),databasePath=path.join(directory,'finance.sqlite3'),ramRoot=path.join(directory,'ram');
  await import('node:fs/promises').then(({mkdir})=>mkdir(ramRoot,{recursive:true}));await migrateUp({databasePath,now:()=>NOW});const db=openDatabase(databasePath);
  const entityId=Number(db.prepare("INSERT INTO business_entities (legal_name,trading_name,default_currency,active,created_at,updated_at) VALUES ('TEST Entity / NOT VALID','TEST','MYR',1,?,?)").run(NOW,NOW).lastInsertRowid);
  const customerId=Number(db.prepare(`INSERT INTO customers (customer_code,legal_name,display_name,billing_address,default_currency,default_payment_terms_days,tax_treatment,purchase_order_required,active,created_at,updated_at)
    VALUES ('TEST-DRIVE','TEST Customer / NOT VALID','TEST Customer','TEST Address / NOT VALID','MYR',14,'TEST / NOT VALID',0,1,?,?)`).run(NOW,NOW).lastInsertRowid);
  db.prepare("INSERT INTO bank_profiles (id,display_name,business_entity_id,currency,bank_name,account_name,account_number,active,created_at,updated_at) VALUES ('cimb-myr','TEST / NOT VALID',?,'MYR','TEST','TEST','0000',1,?,?)").run(entityId,NOW,NOW);
  db.prepare("UPDATE currencies SET default_bank_profile_id='cimb-myr' WHERE code='MYR'").run();db.close();return{directory,databasePath,ramRoot,entityId,customerId};
}

test('confirmed production invoice is stored only in its customer Drive folder',async()=>{
  const value=await fixture(),drive=fakeDrive();try{
    const draft=createStandaloneInvoiceDraft({databasePath:value.databasePath,actor:'test-operator',now:NOW,input:{customer_id:value.customerId,business_entity_id:value.entityId,currency:'MYR',issue_date:'2026-09-12',payment_terms_days:14,service_date:'2026-09-12',payment_terms:'TEST / NOT VALID',notes:'TEST / NOT VALID',source_channel:'test',line_items:[{description:'TEST service / NOT VALID',quantity:'1',unit:'lot',unit_price_minor:10000}],discount:{type:'NONE'},tax:{mode:'NONE'}}});
    createInvoiceConfirmationToken({databasePath:value.databasePath,invoiceId:draft.id,requestingUser:'test-operator',sourceChannel:'test',sourceChat:'test-chat',tokenFactory:()=> 'ID-CCCCCCCCCC',now:NOW});
    const issued=await issueConfirmedInvoice({databasePath:value.databasePath,token:'ID-CCCCCCCCCC',confirmingUser:'test-operator',sourceChannel:'test',sourceChat:'test-chat',clientInitials:'TD',root:path.resolve('.'),testMode:false,
      driveConfiguration:{rootFolderId:ROOT},driveClient:drive,ramRoot:value.ramRoot,allowNonRamTestStorage:true,
      documentRenderer:(args)=>renderInvoiceDocx({...args,testMode:true}),pdfConverter:async({pdfPath})=>writeFile(pdfPath,`%PDF-1.4\n${NUMBER} RM 100.00 TEST / NOT VALID\n%%EOF`),pdfInspector:async({pdfPath})=>({pageCount:1,a4:true,text:await readFile(pdfPath,'utf8')}),now:NOW});
    assert.equal(issued.storage_backend,'DRIVE_ONLY');assert.equal(issued.docx_relative_path,null);assert.equal(issued.pdf_relative_path,null);assert.ok(issued.drive_pdf_file_id);
    assert.equal((await readdir(value.ramRoot)).length,0);await assert.rejects(access(path.join(value.directory,'generated','invoices')));
    const folders=[...drive.items.values()].filter((item)=>item.mimeType==='application/vnd.google-apps.folder'&&item.id!==ROOT);assert.equal(folders.length,1);assert.match(folders[0].name,/^TEST-DRIVE - /);
    assert.deepEqual([...drive.items.values()].filter((item)=>item.parents.includes(folders[0].id)).map((item)=>item.name).sort(),[`${NUMBER}.docx`,`${NUMBER}.pdf`]);
  }finally{await rm(value.directory,{recursive:true,force:true});}
});
