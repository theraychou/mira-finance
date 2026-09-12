import { createHash } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';

const FOLDER_MIME='application/vnd.google-apps.folder';
const digest=(value)=>createHash('sha256').update(value).digest('hex');

export function customerDriveFolderName(customer){
  const code=String(customer?.customer_code??'').trim();
  const name=String(customer?.display_name??customer?.legal_name??'').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
  if(!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)||!name)throw new Error('CUSTOMER_FOLDER_NAME_INVALID');
  return `${code} - ${name}`.slice(0,120).trim();
}

function verify(folder,parentId){
  if(folder.mimeType!==FOLDER_MIME||!folder.parents.includes(parentId))throw new Error('CUSTOMER_DRIVE_FOLDER_INVALID');
  return folder;
}

export async function ensureCustomerDriveFolder({databasePath,customerId,rootFolderId,driveClient,actor,now=new Date().toISOString()}){
  if(!driveClient||!rootFolderId)throw new Error('CUSTOMER_DRIVE_NOT_CONFIGURED');
  const database=openDatabase(databasePath,{readOnly:true});let customer,mapping;
  try{customer=database.prepare('SELECT id,customer_code,legal_name,display_name FROM customers WHERE id=?').get(customerId);mapping=database.prepare('SELECT * FROM customer_drive_folders WHERE customer_id=?').get(customerId);}finally{database.close();}
  if(!customer)throw new Error('CUSTOMER_NOT_FOUND');
  if(mapping){const found=verify(await driveClient.getMetadata(mapping.folder_id),rootFolderId);return {customerId,folderId:found.id,folderName:mapping.folder_name,created:false};}
  const folderName=customerDriveFolderName(customer);
  const matches=(await driveClient.findByName({name:folderName,parentId:rootFolderId})).filter((item)=>item.mimeType===FOLDER_MIME);
  if(matches.length>1)throw new Error('CUSTOMER_DRIVE_FOLDER_AMBIGUOUS');
  const folder=verify(matches[0]??await driveClient.createFolder({name:folderName,parentId:rootFolderId}),rootFolderId);
  const write=openDatabase(databasePath);
  try{withImmediateTransaction(write,()=>write.prepare(`INSERT INTO customer_drive_folders
    (customer_id,folder_id,folder_name,root_folder_id_hash,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(customerId,folder.id,folderName,digest(rootFolderId),actor,now,now));}catch(error){if(!String(error.message).includes('UNIQUE'))throw error;}finally{write.close();}
  return {customerId,folderId:folder.id,folderName,created:matches.length===0};
}

export async function provisionCustomerDriveFolders({databasePath,rootFolderId,driveClient,actor,now=new Date().toISOString()}){
  const database=openDatabase(databasePath,{readOnly:true});let ids;
  try{ids=database.prepare('SELECT id FROM customers ORDER BY customer_code').all().map((row)=>row.id);}finally{database.close();}
  const folders=[];for(const customerId of ids)folders.push(await ensureCustomerDriveFolder({databasePath,customerId,rootFolderId,driveClient,actor,now}));
  return {count:folders.length,folders};
}
