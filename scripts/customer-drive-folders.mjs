#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './lib/database.mjs';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { createGogDriveClient } from './lib/gog-drive-client.mjs';
import { provisionCustomerDriveFolders } from './lib/customer-drive-folders.mjs';

const valueAfter=(flag)=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1];};
export async function main({databasePath=defaultDatabasePath,actor=valueAfter('--actor'),configuration,client}={}){
  if(!process.argv.includes('--admin')||!actor)throw new Error('ADMIN_AND_ACTOR_REQUIRED');
  const config=configuration??await loadDriveConfiguration();const drive=client??createGogDriveClient(config);
  return provisionCustomerDriveFolders({databasePath,rootFolderId:config.rootFolderId,driveClient:drive,actor});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await main();console.log(`PASS customer Drive folders ready: ${result.count}`);
}
