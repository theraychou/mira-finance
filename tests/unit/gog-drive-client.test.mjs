import test from 'node:test';
import assert from 'node:assert/strict';
import { createGogDriveClient } from '../../scripts/lib/gog-drive-client.mjs';

test('gog client restricts commands to Drive and uses non-interactive JSON output',async()=>{
  const calls=[];const runner=async(command,args)=>{calls.push({command,args});return{stdout:JSON.stringify({id:'TEST_FILE_ID',name:'sample.pdf',mimeType:'application/pdf',size:'42',parents:['TEST_FOLDER_ID']})};};
  const client=createGogDriveClient({identity:'operator@example.invalid',client:'mira-drive',runner});
  const metadata=await client.uploadFile({localPath:'/tmp/sample.pdf',name:'sample.pdf',parentId:'TEST_FOLDER_ID'});
  assert.equal(metadata.size,42);assert.equal(calls.length,1);assert.equal(calls[0].command,'gog');
  assert.ok(calls[0].args.includes('--enable-commands=drive'));assert.ok(calls[0].args.includes('--no-input'));assert.ok(calls[0].args.includes('--json'));
  assert.deepEqual(calls[0].args.slice(-5),['drive','upload','/tmp/sample.pdf','--name=sample.pdf','--parent=TEST_FOLDER_ID']);
  assert.ok(!calls[0].args.includes('--force'));assert.ok(!calls[0].args.includes('delete'));
});

test('gog client classifies transient and authorization errors without returning provider details',async()=>{
  const transient=createGogDriveClient({identity:'operator@example.invalid',client:'mira-drive',runner:async()=>{const error=new Error('HTTP 503 private provider response');error.stderr='temporary upstream failure';throw error;}});
  await assert.rejects(transient.getMetadata('TEST_FILE_ID'),error=>error.code==='DRIVE_TRANSIENT_FAILURE'&&error.transient===true&&!error.message.includes('private'));
  const denied=createGogDriveClient({identity:'operator@example.invalid',client:'mira-drive',runner:async()=>{throw new Error('oauth2 invalid_grant secret detail');}});
  await assert.rejects(denied.getMetadata('TEST_FILE_ID'),error=>error.code==='DRIVE_AUTHORIZATION_FAILED'&&error.transient===false&&!error.message.includes('secret'));
});
