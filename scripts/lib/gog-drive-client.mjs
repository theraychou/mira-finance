import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

export class DriveClientError extends Error{
  constructor(code,{transient=false}={}){super(`Google Drive operation failed (${code}).`);this.name='DriveClientError';this.code=code;this.transient=transient;}
}

function classify(error){
  const value=`${error?.message??''} ${error?.stderr??''}`.toLowerCase();
  if(/429|500|502|503|504|timeout|timed out|econnreset|enotfound|rate limit|temporar/.test(value))return new DriveClientError('DRIVE_TRANSIENT_FAILURE',{transient:true});
  if(/invalid_grant|unauthorized_client|insufficient|permission|forbidden|401|403/.test(value))return new DriveClientError('DRIVE_AUTHORIZATION_FAILED');
  if(/not found|404/.test(value))return new DriveClientError('DRIVE_ITEM_NOT_FOUND');
  return new DriveClientError('DRIVE_COMMAND_FAILED');
}

function unwrap(payload){return payload?.file??payload?.result??payload;}
function metadata(payload){
  const value=unwrap(payload);
  if(!value||typeof value!=='object'||typeof value.id!=='string')throw new DriveClientError('DRIVE_RESPONSE_INVALID');
  return {id:value.id,name:value.name??null,mimeType:value.mimeType??value.mime_type??null,size:value.size==null?null:Number(value.size),parents:value.parents??[],md5Checksum:value.md5Checksum??value.md5_checksum??null,webViewLink:value.webViewLink??value.web_view_link??null};
}

export function createGogDriveClient({identity,client,gogCommand='gog',timeoutMs=120000,runner=execFileAsync}){
  if(typeof identity!=='string'||!identity.includes('@'))throw new TypeError('Drive identity is invalid.');
  if(typeof client!=='string'||!client)throw new TypeError('Drive client profile is required.');
  async function run(argumentsList){
    try{
      const {stdout}=await runner(gogCommand,[`--account=${identity}`,`--client=${client}`,'--enable-commands=drive','--no-input','--json',...argumentsList],{timeout:timeoutMs,windowsHide:true,maxBuffer:4*1024*1024});
      return JSON.parse(stdout);
    }catch(error){if(error instanceof DriveClientError)throw error;throw classify(error);}
  }
  return {
    async getMetadata(fileId){return metadata(await run(['drive','get',fileId]));},
    async uploadFile({localPath,name,parentId}){return metadata(await run(['drive','upload',localPath,`--name=${name}`,`--parent=${parentId}`]));},
    async findByName({name,parentId}){
      const escaped=name.replaceAll("'","\\'");
      const payload=await run(['drive','ls',`--parent=${parentId}`,`--query=name = '${escaped}' and trashed = false`,'--max=20']);
      const values=Array.isArray(payload)?payload:(payload.files??payload.items??[]);
      if(!Array.isArray(values))throw new DriveClientError('DRIVE_RESPONSE_INVALID');
      return values.map(metadata);
    }
  };
}
