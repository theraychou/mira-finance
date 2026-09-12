#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath, openDatabase, withImmediateTransaction } from './lib/database.mjs';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { createGogDriveClient } from './lib/gog-drive-client.mjs';
import { ensureCustomerDriveFolder } from './lib/customer-drive-folders.mjs';
import { repositoryRoot } from './validate-config.mjs';

const sha256=(buffer)=>createHash('sha256').update(buffer).digest('hex');
const md5=(buffer)=>createHash('md5').update(buffer).digest('hex');
const valueAfter=(flag)=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1];};

function inside(base,relative){const candidate=path.resolve(base,relative);const rel=path.relative(path.resolve(base),candidate);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('INVOICE_ARTIFACT_OUTSIDE_WORKSPACE');return candidate;}
async function upload({drive,localPath,name,parentId,expectedHash}){
  const info=await lstat(localPath);if(!info.isFile()||info.isSymbolicLink())throw new Error('INVOICE_ARTIFACT_INVALID');
  const bytes=await readFile(localPath);if(sha256(bytes)!==expectedHash)throw new Error('INVOICE_ARTIFACT_HASH_MISMATCH');
  const matches=await drive.findByName({name,parentId});if(matches.length>1)throw new Error('DRIVE_UPLOAD_AMBIGUOUS');
  const file=matches[0]??await drive.uploadFile({localPath,name,parentId});const remote=await drive.getMetadata(file.id);
  if(remote.name!==name||!remote.parents.includes(parentId)||remote.size!==bytes.length||(remote.md5Checksum&&remote.md5Checksum.toLowerCase()!==md5(bytes)))throw new Error('DRIVE_UPLOAD_VERIFICATION_FAILED');
  return remote;
}
async function regularFiles(directory){
  const values=[];async function walk(current){for(const entry of await readdir(current,{withFileTypes:true}).catch((error)=>error.code==='ENOENT'?[]:Promise.reject(error))){const candidate=path.join(current,entry.name);if(entry.isSymbolicLink())throw new Error('INVOICE_STORAGE_SYMLINK_FOUND');if(entry.isDirectory())await walk(candidate);else if(entry.isFile()&&!entry.name.startsWith('.'))values.push(candidate);}}await walk(directory);return values;
}

export async function migrateInvoicesToDriveOnly({databasePath=defaultDatabasePath,root=repositoryRoot,actor,configuration,driveClient}={}){
  if(typeof actor!=='string'||!actor.trim())throw new Error('ACTOR_REQUIRED');const config=configuration??await loadDriveConfiguration({root});const drive=driveClient??createGogDriveClient(config);const outputRoot=path.resolve(root,'generated','invoices');
  const database=openDatabase(databasePath,{readOnly:true});let rows;
  try{rows=database.prepare(`SELECT ii.*,i.customer_id,i.invoice_number,i.drive_docx_file_id,i.drive_pdf_file_id
    FROM invoice_issuances ii JOIN invoices i ON i.id=ii.invoice_id WHERE ii.status='ISSUED' AND ii.docx_relative_path IS NOT NULL AND ii.pdf_relative_path IS NOT NULL ORDER BY ii.invoice_id`).all();}finally{database.close();}
  const migrated=[];
  for(const row of rows){
    const docxPath=inside(outputRoot,row.docx_relative_path),pdfPath=inside(outputRoot,row.pdf_relative_path);
    const folder=await ensureCustomerDriveFolder({databasePath,customerId:row.customer_id,rootFolderId:config.rootFolderId,driveClient:drive,actor});
    const docxName=path.basename(row.docx_relative_path),pdfName=path.basename(row.pdf_relative_path);
    const docx=await upload({drive,localPath:docxPath,name:docxName,parentId:folder.folderId,expectedHash:row.docx_sha256});
    const pdf=await upload({drive,localPath:pdfPath,name:pdfName,parentId:folder.folderId,expectedHash:row.pdf_sha256});
    const write=openDatabase(databasePath);try{withImmediateTransaction(write,()=>{
      write.prepare(`UPDATE invoice_issuances SET storage_backend='DRIVE_ONLY',drive_folder_id=?,docx_file_name=?,pdf_file_name=?,updated_at=? WHERE invoice_id=?`)
        .run(folder.folderId,docxName,pdfName,new Date().toISOString(),row.invoice_id);
      write.prepare('UPDATE invoices SET drive_docx_file_id=?,drive_pdf_file_id=? WHERE id=?').run(docx.id,pdf.id,row.invoice_id);
      write.prepare(`INSERT OR IGNORE INTO invoice_drive_storage_attempts
        (invoice_id,attempt_number,result,folder_id_hash,docx_file_id_hash,pdf_file_id_hash,actor,occurred_at) VALUES (?,?,'SUCCEEDED',?,?,?,?,?)`)
        .run(row.invoice_id,row.attempt_count,sha256(Buffer.from(folder.folderId)),sha256(Buffer.from(docx.id)),sha256(Buffer.from(pdf.id)),actor,new Date().toISOString());
    });}finally{write.close();}
    await rm(docxPath,{force:true});await rm(pdfPath,{force:true});
    const cleared=openDatabase(databasePath);try{withImmediateTransaction(cleared,()=>cleared.prepare('UPDATE invoice_issuances SET docx_relative_path=NULL,pdf_relative_path=NULL,updated_at=? WHERE invoice_id=?').run(new Date().toISOString(),row.invoice_id));}finally{cleared.close();}
    migrated.push(row.invoice_number);
  }
  const remaining=await regularFiles(outputRoot);if(remaining.length)throw new Error(`UNMIGRATED_INVOICE_FILES_REMAIN:${remaining.length}`);
  return {migratedCount:migrated.length,remainingFileCount:remaining.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv.includes('--admin'))throw new Error('ADMIN_FLAG_REQUIRED');const result=await migrateInvoicesToDriveOnly({actor:valueAfter('--actor')});console.log(`PASS invoices migrated to Drive-only: ${result.migratedCount}; server files remaining: ${result.remainingFileCount}`);
}
