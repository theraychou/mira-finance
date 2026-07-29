#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDriveConfiguration } from './lib/drive-configuration.mjs';
import { createGogDriveClient } from './lib/gog-drive-client.mjs';
import { validateApprovedDriveFolder } from './lib/drive-uploads.mjs';
import { repositoryRoot } from './validate-config.mjs';

export async function runDriveHealthCheck({root=repositoryRoot,configuration,client}={}){
  try{
    const config=configuration??await loadDriveConfiguration({root});
    const drive=client??createGogDriveClient(config);
    await validateApprovedDriveFolder({configuration:config,client:drive});
    return{healthy:true,status:'CONFIGURED',detail:'approved Finance folder is reachable as a folder'};
  }catch(error){return{healthy:false,status:'FAIL',detail:`Drive health check failed (${typeof error?.code==='string'?error.code:'DRIVE_CONFIGURATION_INVALID'}).`};}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await runDriveHealthCheck();
  console.log(process.argv.includes('--json')?JSON.stringify(report):`${report.healthy?'PASS':'FAIL'} ${report.detail}`);
  if(!report.healthy)process.exitCode=1;
}
