import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateUp } from '../../scripts/lib/migrations.mjs';
import { openDatabase } from '../../scripts/lib/database.mjs';
import { validateDriveConfiguration } from '../../scripts/lib/drive-configuration.mjs';
import { DriveClientError } from '../../scripts/lib/gog-drive-client.mjs';
import { retryDueDriveUploads, uploadIssuedDocument } from '../../scripts/lib/drive-uploads.mjs';
import { runDriveHealthCheck } from '../../scripts/drive-health-check.mjs';

const NOW='2026-07-29T00:00:00.000Z',FOLDER='TEST_APPROVED_FOLDER_0001';
const CONFIG=validateDriveConfiguration({schemaVersion:1,identity:'operator@example.invalid',client:'mira-drive',rootFolderId:FOLDER,destinations:{quotation:FOLDER,invoice:FOLDER}});
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');

class FakeDrive{
  constructor({transientFile=null,unavailable=false}={}){this.files=new Map();this.uploadCount=0;this.transientFile=transientFile;this.failed=false;this.unavailable=unavailable;}
  async getMetadata(id){if(this.unavailable)throw new DriveClientError('DRIVE_TRANSIENT_FAILURE',{transient:true});if(id===FOLDER)return{id:FOLDER,name:'TEST Finance',mimeType:'application/vnd.google-apps.folder',size:null,parents:[],md5Checksum:null};const file=this.files.get(id);if(!file)throw new DriveClientError('DRIVE_ITEM_NOT_FOUND');return file;}
  async findByName({name,parentId}){return[...this.files.values()].filter(file=>file.name===name&&file.parents.includes(parentId));}
  async uploadFile({localPath,name,parentId}){if(name===this.transientFile&&!this.failed){this.failed=true;throw new DriveClientError('DRIVE_TRANSIENT_FAILURE',{transient:true});}const buffer=await readFile(localPath),metadata=await stat(localPath);const id=`TEST_DRIVE_FILE_${this.uploadCount+1}`;this.uploadCount+=1;const file={id,name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:metadata.size,parents:[parentId],md5Checksum:createHash('md5').update(buffer).digest('hex')};this.files.set(id,file);return file;}
}

async function fixture(documentType='quotation'){
  const root=await mkdtemp(path.join(os.tmpdir(),'mira-f8-')),databasePath=path.join(root,'data','finance.sqlite3');await migrateUp({databasePath,now:()=>NOW});
  const number=documentType==='quotation'?'2607291001-QT':'2607291001-IT',directory=path.join(root,'generated',`${documentType}s`,'2026','07');await mkdir(directory,{recursive:true,mode:0o700});
  const docx=Buffer.from('TEST / NOT VALID — synthetic DOCX fixture'),pdf=Buffer.from('%PDF-1.4\nTEST / NOT VALID — synthetic PDF fixture\n%%EOF');
  await writeFile(path.join(directory,`${number}.docx`),docx,{mode:0o600});await writeFile(path.join(directory,`${number}.pdf`),pdf,{mode:0o600});
  const db=openDatabase(databasePath),entityTable=documentType==='quotation'?'quotations':'invoices',numberColumn=documentType==='quotation'?'quotation_number':'invoice_number',idColumn=documentType==='quotation'?'quotation_id':'invoice_id',issuanceTable=documentType==='quotation'?'quotation_issuances':'invoice_issuances';
  const entityId=Number(db.prepare(`INSERT INTO ${entityTable} (${numberColumn},status,created_by,created_at${documentType==='invoice'?',subtotal_minor,total_minor,balance_due_minor':''}) VALUES (?,'ISSUED','test-user',?${documentType==='invoice'?',10000,10000,10000':''})`).run(number,NOW).lastInsertRowid);
  const allocationId=Number(db.prepare(`INSERT INTO document_numbers (document_type,sequence_date,sequence_value,client_initials,document_number,status,entity_id,allocated_at,updated_at) VALUES (?,'2026-07-29',1001,?,?, 'ISSUED',?,?,?)`).run(documentType,documentType==='quotation'?'QT':'IT',number,entityId,NOW,NOW).lastInsertRowid);
  const confirmationId=Number(db.prepare(`INSERT INTO pending_confirmations (token,draft_type,draft_id,draft_hash,requesting_user,source_channel,source_chat,status,expires_at,created_at,confirmed_at) VALUES (?,?,?,?,?,'test','test-chat','CONFIRMED',?,?,?)`).run(`${documentType==='quotation'?'QD':'ID'}-EEEEEEEEEE`,documentType,entityId,'a'.repeat(64),'test-user','2026-07-29T01:00:00.000Z',NOW,NOW).lastInsertRowid);
  db.prepare(`INSERT INTO ${issuanceTable} (${idColumn},document_number_id,confirmation_id,draft_version,draft_hash,status,attempt_count,docx_relative_path,pdf_relative_path,docx_sha256,pdf_sha256,issued_by,issued_at,created_at,updated_at) VALUES (?,?,?,?,?,'ISSUED',1,?,?,?,?,?,?,?,?)`)
    .run(entityId,allocationId,confirmationId,1,'a'.repeat(64),`2026/07/${number}.docx`,`2026/07/${number}.pdf`,hash(docx),hash(pdf),'test-user',NOW,NOW,NOW);db.close();
  return{root,databasePath,documentType,entityId,number,docxPath:path.join(directory,`${number}.docx`),pdfPath:path.join(directory,`${number}.pdf`)};
}
async function cleanup(ids){const db=openDatabase(ids.databasePath);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec('PRAGMA journal_mode=DELETE');db.close();await rm(ids.root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}

for(const documentType of ['quotation','invoice'])test(`uploads and verifies both issued ${documentType} artifacts without duplicates`,async()=>{
  const ids=await fixture(documentType),client=new FakeDrive();try{
    const first=await uploadIssuedDocument({databasePath:ids.databasePath,documentType,entityId:ids.entityId,actor:'test-user',root:ids.root,configuration:CONFIG,client,now:'2026-07-29T00:01:00.000Z'});assert.equal(first.status,'COMPLETED');assert.equal(client.uploadCount,2);
    const second=await uploadIssuedDocument({databasePath:ids.databasePath,documentType,entityId:ids.entityId,actor:'test-user',root:ids.root,configuration:CONFIG,client,now:'2026-07-29T00:02:00.000Z'});assert.equal(second.status,'COMPLETED');assert.equal(client.uploadCount,2);
    const db=openDatabase(ids.databasePath);assert.equal(db.prepare('SELECT COUNT(*) count FROM drive_uploads WHERE status=\'COMPLETED\'').get().count,2);const entity=db.prepare(`SELECT drive_docx_file_id,drive_pdf_file_id FROM ${documentType==='quotation'?'quotations':'invoices'} WHERE id=?`).get(ids.entityId);assert.ok(entity.drive_docx_file_id);assert.ok(entity.drive_pdf_file_id);assert.throws(()=>db.prepare('UPDATE drive_upload_attempts SET result=\'FAILED\'').run(),/append-only/);db.close();
  }finally{await cleanup(ids);}
});

test('transient failure queues retry, later completes, and preserves local files',async()=>{
  const ids=await fixture('invoice'),client=new FakeDrive();client.transientFile=`${ids.number}.docx`;try{
    const first=await uploadIssuedDocument({databasePath:ids.databasePath,documentType:'invoice',entityId:ids.entityId,actor:'test-user',root:ids.root,configuration:CONFIG,client,now:'2026-07-29T00:01:00.000Z'});assert.equal(first.status,'PENDING');assert.equal((await stat(ids.docxPath)).isFile(),true);assert.equal((await stat(ids.pdfPath)).isFile(),true);
    const retried=await retryDueDriveUploads({databasePath:ids.databasePath,actor:'test-user',root:ids.root,configuration:CONFIG,client,now:'2026-07-29T00:06:00.000Z'});assert.equal(retried.length,1);assert.equal(retried[0].status,'COMPLETED');
    const db=openDatabase(ids.databasePath,{readOnly:true});assert.equal(db.prepare("SELECT COUNT(*) count FROM drive_uploads WHERE status='COMPLETED'").get().count,2);assert.deepEqual(db.prepare('SELECT result FROM drive_upload_attempts ORDER BY id').all().map(row=>row.result),['FAILED','SUCCEEDED','SUCCEEDED']);db.close();
  }finally{await cleanup(ids);}
});

test('unapproved destinations are rejected and Drive health output redacts identifiers',async()=>{
  assert.throws(()=>validateDriveConfiguration({schemaVersion:1,identity:'operator@example.invalid',client:'mira-drive',rootFolderId:FOLDER,destinations:{quotation:FOLDER,invoice:'DIFFERENT_FOLDER_0001'}}),/approved F8 root folder/);
  const healthy=await runDriveHealthCheck({configuration:CONFIG,client:new FakeDrive()});assert.equal(healthy.healthy,true);assert.doesNotMatch(JSON.stringify(healthy),/operator|TEST_APPROVED/);
  const failed=await runDriveHealthCheck({configuration:CONFIG,client:new FakeDrive({unavailable:true})});assert.equal(failed.healthy,false);assert.match(failed.detail,/DRIVE_TRANSIENT_FAILURE/);assert.doesNotMatch(JSON.stringify(failed),/operator|TEST_APPROVED/);
});
