import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../validate-config.mjs';

const folderIdPattern=/^[A-Za-z0-9_-]{10,128}$/;
const clientPattern=/^[a-z][a-z0-9-]{1,31}$/;

export function validateDriveConfiguration(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Drive configuration must be an object.');
  if(value.schemaVersion!==1)throw new Error('Unsupported Drive configuration schema version.');
  if(typeof value.identity!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.identity))throw new Error('Drive identity must be an email address.');
  if(typeof value.client!=='string'||!clientPattern.test(value.client))throw new Error('Drive client profile is invalid.');
  if(!folderIdPattern.test(value.rootFolderId??''))throw new Error('Drive root folder ID is invalid.');
  const destinations=value.destinations;
  if(!destinations||Object.keys(destinations).sort().join(',')!=='invoice,quotation')throw new Error('Drive destinations must define only invoice and quotation.');
  for(const type of ['quotation','invoice']){
    if(!folderIdPattern.test(destinations[type]))throw new Error(`Drive destination for ${type} is invalid.`);
    if(destinations[type]!==value.rootFolderId)throw new Error(`Drive destination for ${type} must remain inside the approved F8 root folder.`);
  }
  return Object.freeze({schemaVersion:1,identity:value.identity,client:value.client,rootFolderId:value.rootFolderId,destinations:Object.freeze({...destinations})});
}

export async function loadDriveConfiguration({root=repositoryRoot,configPath=path.join(root,'config','drive-folders.json')}={}){
  const raw=await readFile(configPath,'utf8');
  return validateDriveConfiguration(JSON.parse(raw));
}

export function approvedFolderFor(configuration,documentType){
  if(!['quotation','invoice'].includes(documentType))throw new TypeError('Unsupported Drive document type.');
  const folderId=configuration.destinations[documentType];
  if(!folderId||folderId!==configuration.rootFolderId)throw new Error('UNAPPROVED_DRIVE_DESTINATION');
  return folderId;
}
