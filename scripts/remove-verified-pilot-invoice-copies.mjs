#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase,withImmediateTransaction } from './lib/database.mjs';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { createGogDriveClient } from './lib/gog-drive-client.mjs';
import { repositoryRoot } from './validate-config.mjs';

const sha=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
function safePath(root,relative){const candidate=path.resolve(root,relative),rel=path.relative(path.resolve(root),candidate);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('PILOT_ARTIFACT_PATH_INVALID');return candidate;}
async function remaining(root){const files=[];async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true}).catch((error)=>error.code==='ENOENT'?[]:Promise.reject(error))){const candidate=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('PILOT_ARTIFACT_SYMLINK');if(entry.isDirectory())await walk(candidate);else if(entry.isFile()&&!entry.name.startsWith('.'))files.push(candidate);}}await walk(root);return files;}

export async function removeVerifiedPilotInvoiceCopies({databasePath,pathRoot=repositoryRoot,configuration,driveClient,actor}={}){
  if(!databasePath||!actor)throw new Error('PILOT_DATABASE_AND_ACTOR_REQUIRED');const config=configuration??await loadDriveConfiguration({root:pathRoot});const drive=driveClient??createGogDriveClient(config);const outputRoot=path.join(pathRoot,'generated','invoices');
  const database=openDatabase(databasePath,{readOnly:true});let rows;
  try{rows=database.prepare(`SELECT i.id,i.invoice_number,i.drive_docx_file_id,i.drive_pdf_file_id,ii.docx_relative_path,ii.pdf_relative_path,ii.docx_sha256,ii.pdf_sha256,s.snapshot_json
    FROM invoices i JOIN invoice_issuances ii ON ii.invoice_id=i.id JOIN invoice_draft_state s ON s.invoice_id=i.id WHERE i.status='ISSUED' AND ii.status='ISSUED' ORDER BY i.id`).all();}finally{database.close();}
  const verified=[];
  for(const row of rows){if(!row.snapshot_json.includes('TEST / NOT VALID'))throw new Error('NON_TEST_PILOT_INVOICE_REFUSED');
    for(const kind of ['docx','pdf']){const localPath=safePath(outputRoot,row[`${kind}_relative_path`]),bytes=await readFile(localPath),info=await lstat(localPath);if(!info.isFile()||info.isSymbolicLink()||sha('sha256',bytes)!==row[`${kind}_sha256`])throw new Error('PILOT_ARTIFACT_HASH_MISMATCH');
      const read=openDatabase(databasePath,{readOnly:true});let upload;try{upload=read.prepare("SELECT * FROM drive_uploads WHERE document_type='invoice' AND entity_id=? AND artifact_kind=? AND status='COMPLETED'").get(row.id,kind.toUpperCase());}finally{read.close();}
      if(!upload||upload.local_sha256!==sha('sha256',bytes)||upload.local_size!==bytes.length||upload.drive_file_id!==row[`drive_${kind}_file_id`])throw new Error('PILOT_DRIVE_RECORD_INVALID');
      const remote=await drive.getMetadata(upload.drive_file_id);if(remote.name!==upload.file_name||remote.size!==bytes.length||!remote.parents.includes(upload.folder_id)||(remote.md5Checksum&&remote.md5Checksum.toLowerCase()!==sha('md5',bytes)))throw new Error('PILOT_DRIVE_VERIFICATION_FAILED');
      verified.push({invoiceId:row.id,kind,localPath,fileName:upload.file_name,fileId:upload.drive_file_id,folderId:upload.folder_id});
    }}
  for(const item of verified)await rm(item.localPath,{force:true});
  const write=openDatabase(databasePath);try{withImmediateTransaction(write,()=>{for(const row of rows){const docx=verified.find((item)=>item.invoiceId===row.id&&item.kind==='docx'),pdf=verified.find((item)=>item.invoiceId===row.id&&item.kind==='pdf');write.prepare(`UPDATE invoice_issuances SET storage_backend='DRIVE_ONLY',drive_folder_id=?,docx_file_name=?,pdf_file_name=?,docx_relative_path=NULL,pdf_relative_path=NULL,updated_at=? WHERE invoice_id=?`).run(docx.folderId,docx.fileName,pdf.fileName,new Date().toISOString(),row.id);}});}finally{write.close();}
  const files=await remaining(outputRoot);if(files.length)throw new Error(`PILOT_INVOICE_FILES_REMAIN:${files.length}`);return{removedCount:verified.length,remainingFileCount:files.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv.includes('--admin'))throw new Error('ADMIN_FLAG_REQUIRED');const result=await removeVerifiedPilotInvoiceCopies({databasePath:path.join(repositoryRoot,'data','pilots','f11-pilot.sqlite3'),actor:'phase-f20-deploy'});console.log(`PASS verified pilot invoice copies removed: ${result.removedCount}; remaining: ${result.remainingFileCount}`);
}
