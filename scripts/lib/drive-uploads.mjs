import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { approvedFolderFor, loadDriveConfiguration } from './drive-configuration.mjs';
import { createGogDriveClient, DriveClientError } from './gog-drive-client.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { repositoryRoot } from '../validate-config.mjs';
import { recordFailureAlert } from './runtime-safety.mjs';

const TYPES={quotation:{entityTable:'quotations',issuanceTable:'quotation_issuances',idColumn:'quotation_id',numberColumn:'quotation_number',outputDirectory:'quotations'},invoice:{entityTable:'invoices',issuanceTable:'invoice_issuances',idColumn:'invoice_id',numberColumn:'invoice_number',outputDirectory:'invoices'}};
function text(value,name){if(typeof value!=='string'||!value.trim())throw new TypeError(`${name} is required.`);return value.trim();}
function instant(value,name='now'){const date=new Date(value);if(typeof value!=='string'||Number.isNaN(date.valueOf())||date.toISOString()!==value)throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);return date;}
function sha256(buffer){return createHash('sha256').update(buffer).digest('hex');}
function md5(buffer){return createHash('md5').update(buffer).digest('hex');}
function safePath(root,relative){const base=path.resolve(root),candidate=path.resolve(base,relative);if(candidate===base||!candidate.startsWith(`${base}${path.sep}`))throw new Error('LOCAL_DOCUMENT_PATH_INVALID');return candidate;}
function errorCode(error){return typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)?error.code:'DRIVE_UPLOAD_FAILED';}
function retryAt(now,attempt){const minutes=Math.min(1440,5*(2**Math.min(attempt-1,8)));return new Date(new Date(now).valueOf()+minutes*60000).toISOString();}

function audit(database,{now,actor,action,documentType,entityId,result='PASS',details={}}){database.prepare(`INSERT INTO audit_events
  (timestamp,actor,action,entity_type,entity_id,result,details_json) VALUES (?,?,?,?,?,?,?)`).run(now,actor,action,documentType,entityId,result,canonicalJson(details));}

async function sourceArtifacts({databasePath,documentType,entityId,root,configuration,now,actor}){
  const definition=TYPES[documentType];if(!definition)throw new TypeError('Unsupported Drive document type.');
  const database=openDatabase(databasePath,{readOnly:true});let row;
  try{row=database.prepare(`SELECT e.id,e.status,e.${definition.numberColumn} AS document_number,i.status AS issuance_status,
    i.docx_relative_path,i.pdf_relative_path,i.docx_sha256,i.pdf_sha256
    FROM ${definition.entityTable} e JOIN ${definition.issuanceTable} i ON i.${definition.idColumn}=e.id WHERE e.id=?`).get(entityId);}finally{database.close();}
  if(!row||row.status!=='ISSUED'||row.issuance_status!=='ISSUED')throw new Error('DOCUMENT_NOT_ISSUED');
  const outputRoot=path.join(root,'generated',definition.outputDirectory),folderId=approvedFolderFor(configuration,documentType);
  const artifacts=[];
  for(const kind of ['DOCX','PDF']){
    const key=kind.toLowerCase(),relative=row[`${key}_relative_path`],expectedHash=row[`${key}_sha256`];
    const filePath=safePath(outputRoot,relative),buffer=await readFile(filePath),metadata=await stat(filePath);
    if(!metadata.isFile()||metadata.size<1||sha256(buffer)!==expectedHash)throw new Error('LOCAL_DOCUMENT_HASH_MISMATCH');
    artifacts.push({kind,relative,filePath,fileName:path.basename(relative),sha256:expectedHash,md5:md5(buffer),size:metadata.size,folderId});
  }
  const writable=openDatabase(databasePath);
  try{return withImmediateTransaction(writable,()=>{
    const queued=[];
    for(const artifact of artifacts){
      writable.prepare(`INSERT INTO drive_uploads
        (document_type,entity_id,artifact_kind,local_relative_path,local_sha256,local_size,folder_id,file_name,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'PENDING',?,?) ON CONFLICT(document_type,entity_id,artifact_kind) DO NOTHING`)
        .run(documentType,entityId,artifact.kind,artifact.relative,artifact.sha256,artifact.size,artifact.folderId,artifact.fileName,now,now);
      const upload=writable.prepare('SELECT * FROM drive_uploads WHERE document_type=? AND entity_id=? AND artifact_kind=?').get(documentType,entityId,artifact.kind);
      if(upload.local_sha256!==artifact.sha256||upload.local_size!==artifact.size||upload.folder_id!==artifact.folderId||upload.file_name!==artifact.fileName)throw new Error('DRIVE_UPLOAD_SNAPSHOT_MISMATCH');
      queued.push({...upload,filePath:artifact.filePath,localMd5:artifact.md5});
    }
    audit(writable,{now,actor,action:'drive.upload_queued',documentType,entityId,details:{artifactCount:queued.length,alreadyCompleted:queued.filter(x=>x.status==='COMPLETED').length}});
    return queued;
  });}finally{writable.close();}
}

function reserveAttempt(databasePath,uploadId,actor,now){const database=openDatabase(databasePath);try{return withImmediateTransaction(database,()=>{
  const row=database.prepare('SELECT * FROM drive_uploads WHERE id=?').get(uploadId);if(!row)throw new Error('DRIVE_UPLOAD_NOT_FOUND');
  if(row.status==='COMPLETED')return{completed:true,row};
  if(!['PENDING','RETRY_PENDING','PERMANENT_FAILURE'].includes(row.status))throw new Error('DRIVE_UPLOAD_NOT_READY');
  const attempt=row.attempt_count+1;database.prepare("UPDATE drive_uploads SET status='UPLOADING',attempt_count=?,next_attempt_at=NULL,last_error_code=NULL,updated_at=? WHERE id=?").run(attempt,now,uploadId);
  return{completed:false,row:{...row,status:'UPLOADING',attempt_count:attempt},actor};
});}finally{database.close();}}

function recordFailure(databasePath,reservation,error,actor,now){const code=errorCode(error),transient=error instanceof DriveClientError&&error.transient;const database=openDatabase(databasePath);try{withImmediateTransaction(database,()=>{
  const status=transient?'RETRY_PENDING':'PERMANENT_FAILURE',next=transient?retryAt(now,reservation.row.attempt_count):null;
  database.prepare('UPDATE drive_uploads SET status=?,next_attempt_at=?,last_error_code=?,updated_at=? WHERE id=?').run(status,next,code,now,reservation.row.id);
  database.prepare(`INSERT INTO drive_upload_attempts (drive_upload_id,attempt_number,result,error_code,actor,occurred_at) VALUES (?,?,'FAILED',?,?,?)`).run(reservation.row.id,reservation.row.attempt_count,code,actor,now);
  audit(database,{now,actor,action:'drive.upload_failed',documentType:reservation.row.document_type,entityId:reservation.row.entity_id,result:'FAIL',details:{artifactKind:reservation.row.artifact_kind,errorCode:code,retryScheduled:transient}});
});}finally{database.close();}return{status:transient?'RETRY_PENDING':'PERMANENT_FAILURE',errorCode:code,nextAttemptAt:transient?retryAt(now,reservation.row.attempt_count):null};}

function recordSuccess(databasePath,reservation,remote,verifiedHash,actor,now){const database=openDatabase(databasePath);try{return withImmediateTransaction(database,()=>{
  const row=database.prepare('SELECT status FROM drive_uploads WHERE id=?').get(reservation.row.id);if(!row||row.status!=='UPLOADING')throw new Error('DRIVE_UPLOAD_STATE_CHANGED');
  database.prepare(`UPDATE drive_uploads SET status='COMPLETED',drive_file_id=?,next_attempt_at=NULL,last_error_code=NULL,updated_at=?,completed_at=? WHERE id=?`).run(remote.id,now,now,reservation.row.id);
  database.prepare(`INSERT INTO drive_upload_attempts (drive_upload_id,attempt_number,result,drive_file_id,verified_size,verified_hash,actor,occurred_at) VALUES (?,?,'SUCCEEDED',?,?,?,?,?)`).run(reservation.row.id,reservation.row.attempt_count,remote.id,remote.size,verifiedHash,actor,now);
  const definition=TYPES[reservation.row.document_type],column=reservation.row.artifact_kind==='DOCX'?'drive_docx_file_id':'drive_pdf_file_id';
  database.prepare(`UPDATE ${definition.entityTable} SET ${column}=? WHERE id=?`).run(remote.id,reservation.row.entity_id);
  audit(database,{now,actor,action:'drive.upload_completed',documentType:reservation.row.document_type,entityId:reservation.row.entity_id,details:{artifactKind:reservation.row.artifact_kind,sizeVerified:true,hashVerified:Boolean(verifiedHash)}});
  return database.prepare('SELECT * FROM drive_uploads WHERE id=?').get(reservation.row.id);
});}finally{database.close();}}

async function processUpload({databasePath,upload,client,actor,root,now}){
  const reservation=reserveAttempt(databasePath,upload.id,actor,now);if(reservation.completed)return reservation.row;
  try{
    const candidates=await client.findByName({name:upload.file_name,parentId:upload.folder_id});
    if(candidates.length>1)throw new DriveClientError('DRIVE_DUPLICATE_AMBIGUOUS');
    let remote=candidates[0]??await client.uploadFile({localPath:upload.filePath,name:upload.file_name,parentId:upload.folder_id});
    remote=await client.getMetadata(remote.id);
    if(remote.name!==upload.file_name||remote.size!==upload.local_size||!remote.parents.includes(upload.folder_id))throw new DriveClientError('DRIVE_UPLOAD_VERIFICATION_FAILED');
    let verifiedHash=null;if(remote.md5Checksum){if(remote.md5Checksum.toLowerCase()!==upload.localMd5)throw new DriveClientError('DRIVE_UPLOAD_HASH_MISMATCH');verifiedHash=`md5:${remote.md5Checksum.toLowerCase()}`;}
    return recordSuccess(databasePath,reservation,remote,verifiedHash,actor,now);
  }catch(error){const failure=recordFailure(databasePath,reservation,error,actor,now);await recordFailureAlert({root,code:failure.errorCode,operation:'DRIVE_UPLOAD',entityType:reservation.row.document_type,entityId:reservation.row.entity_id,now}).catch(()=>{});return{...reservation.row,...failure};}
}

export async function validateApprovedDriveFolder({configuration,client}){
  const folder=await client.getMetadata(configuration.rootFolderId);
  if(folder.id!==configuration.rootFolderId||folder.mimeType!=='application/vnd.google-apps.folder')throw new DriveClientError('DRIVE_APPROVED_FOLDER_INVALID');
  return{id:folder.id,name:folder.name,mimeType:folder.mimeType};
}

export async function uploadIssuedDocument({databasePath,documentType,entityId,actor,root=repositoryRoot,configuration,client,now=new Date().toISOString()}){
  instant(now);text(actor,'actor');if(!Number.isSafeInteger(entityId)||entityId<1)throw new TypeError('entityId must be a positive integer.');
  const config=configuration??await loadDriveConfiguration({root});const drive=client??createGogDriveClient(config);
  await validateApprovedDriveFolder({configuration:config,client:drive});
  const queued=await sourceArtifacts({databasePath,documentType,entityId,root,configuration:config,now,actor});
  const results=[];for(const upload of queued)results.push(await processUpload({databasePath,upload,client:drive,actor,root,now}));
  return{documentType,entityId,status:results.every(row=>row.status==='COMPLETED')?'COMPLETED':'PENDING',uploads:results};
}

export async function retryDueDriveUploads({databasePath,actor,root=repositoryRoot,configuration,client,now=new Date().toISOString()}){
  instant(now);text(actor,'actor');const config=configuration??await loadDriveConfiguration({root}),drive=client??createGogDriveClient(config);
  await validateApprovedDriveFolder({configuration:config,client:drive});const database=openDatabase(databasePath,{readOnly:true});let rows;
  try{rows=database.prepare("SELECT * FROM drive_uploads WHERE status='RETRY_PENDING' AND next_attempt_at<=? ORDER BY id").all(now);}finally{database.close();}
  const results=[];for(const row of rows){const definition=TYPES[row.document_type],filePath=safePath(path.join(root,'generated',definition.outputDirectory),row.local_relative_path),buffer=await readFile(filePath);results.push(await processUpload({databasePath,upload:{...row,filePath,localMd5:md5(buffer)},client:drive,actor,root,now}));}
  return results;
}
