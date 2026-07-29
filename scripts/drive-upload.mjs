#!/usr/bin/env node
import { uploadIssuedDocument, retryDueDriveUploads } from './lib/drive-uploads.mjs';
import { defaultDatabasePath } from './lib/database.mjs';

function value(flag){const index=process.argv.indexOf(flag);return index>=0?process.argv[index+1]:undefined;}
const actor=value('--actor');
if(!actor)throw new Error('--actor is required.');
if(process.argv.includes('--retry-due')){
  const results=await retryDueDriveUploads({databasePath:defaultDatabasePath,actor});
  console.log(`PASS processed ${results.length} due Drive upload(s).`);
}else{
  const documentType=value('--type'),entityId=Number(value('--id'));
  if(!['quotation','invoice'].includes(documentType)||!Number.isSafeInteger(entityId)||entityId<1)throw new Error('--type quotation|invoice and a positive --id are required.');
  const result=await uploadIssuedDocument({databasePath:defaultDatabasePath,documentType,entityId,actor});
  console.log(`${result.status==='COMPLETED'?'PASS':'PENDING'} ${documentType} ${entityId}; ${result.uploads.filter(row=>row.status==='COMPLETED').length}/2 artifact(s) uploaded.`);
}
