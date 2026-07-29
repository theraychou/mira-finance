import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';

const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function text(value,name){if(typeof value!=='string'||!value.trim())throw new TypeError(`${name} is required.`);return value.trim();}
function optional(value){return typeof value==='string'&&value.trim()?value.trim():null;}
function instant(value,name){const d=new Date(value);if(typeof value!=='string'||Number.isNaN(d.valueOf())||d.toISOString()!==value)throw new TypeError(`${name} must be an ISO-8601 UTC instant.`);return d;}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)!==value)throw new TypeError('paymentDate must be a real YYYY-MM-DD date.');return value;}
function digest(value){return createHash('sha256').update(canonicalJson(value)).digest('hex');}

export function generatePaymentConfirmationToken(randomSource=randomBytes){const bytes=randomSource(10);if(!(bytes instanceof Uint8Array)||bytes.length<10)throw new TypeError('randomSource must return at least 10 bytes.');let body='';for(let i=0;i<10;i+=1)body+=ALPHABET[bytes[i]%ALPHABET.length];return `PM-${body}`;}

export function createPaymentStatusDraft({databasePath,invoiceId,amountMinor,paymentDate,paymentReference=null,requestingUser,sourceChannel,sourceChat,sourceMessageReference=null,ttlMinutes=15,tokenFactory=generatePaymentConfirmationToken,now=new Date().toISOString()}){
  const created=instant(now,'now');date(paymentDate);if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new TypeError('amountMinor must be a positive safe integer.');
  if(!Number.isInteger(ttlMinutes)||ttlMinutes<1||ttlMinutes>1440)throw new RangeError('ttlMinutes must be from 1 to 1440.');
  const database=openDatabase(databasePath);try{return withImmediateTransaction(database,()=>{
    const invoice=database.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);if(!invoice)throw new Error('INVOICE_NOT_FOUND');
    if(invoice.status!=='ISSUED')throw new Error('INVOICE_NOT_ISSUED');if(invoice.payment_status==='PAID'||invoice.balance_due_minor===0)throw new Error('INVOICE_ALREADY_PAID');
    if(amountMinor>invoice.balance_due_minor)throw new Error('OVERPAYMENT_BLOCKED');
    database.prepare("UPDATE invoice_payment_drafts SET status='INVALIDATED' WHERE invoice_id=? AND status='PENDING'").run(invoiceId);
    const token=tokenFactory();if(!/^PM-[A-Z2-9]{10}$/.test(token))throw new TypeError('tokenFactory returned an invalid payment token.');
    const snapshot={invoiceId,amountMinor,paymentDate,paymentReference:optional(paymentReference),priorAmountPaidMinor:invoice.amount_paid_minor,priorBalanceDueMinor:invoice.balance_due_minor};
    const draftHash=digest(snapshot),expiresAt=new Date(created.valueOf()+ttlMinutes*60000).toISOString();
    const row=database.prepare(`INSERT INTO invoice_payment_drafts
      (token,invoice_id,amount_minor,payment_date,payment_reference,prior_amount_paid_minor,prior_balance_due_minor,draft_hash,requesting_user,source_channel,source_chat,source_message_reference,status,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING',?,?)`).run(token,invoiceId,amountMinor,paymentDate,snapshot.paymentReference,invoice.amount_paid_minor,invoice.balance_due_minor,draftHash,text(requestingUser,'requestingUser'),text(sourceChannel,'sourceChannel'),text(sourceChat,'sourceChat'),optional(sourceMessageReference),expiresAt,now);
    database.prepare(`INSERT INTO audit_events (timestamp,actor,action,entity_type,entity_id,after_hash,source_channel,source_chat,source_message_reference,result,details_json)
      VALUES (?,?,'invoice.payment_confirmation_requested','invoice',?,?,?,?,?,'PASS',?)`).run(now,requestingUser,invoiceId,draftHash,sourceChannel,sourceChat,optional(sourceMessageReference),canonicalJson({amountMinor,referenceRecorded:Boolean(snapshot.paymentReference)}));
    return{id:Number(row.lastInsertRowid),token,invoiceId,amountMinor,status:'PENDING',expiresAt,draftHash};
  });}finally{database.close();}
}

export function confirmPaymentStatus({databasePath,token,confirmingUser,sourceChannel,sourceChat,now=new Date().toISOString()}){
  const current=instant(now,'now');const database=openDatabase(databasePath);try{return withImmediateTransaction(database,()=>{
    const draft=database.prepare('SELECT * FROM invoice_payment_drafts WHERE token=?').get(text(token,'token'));if(!draft)throw new Error('PAYMENT_TOKEN_NOT_FOUND');
    if(draft.status!=='PENDING')throw new Error('PAYMENT_TOKEN_NOT_PENDING');
    if(new Date(draft.expires_at).valueOf()<=current.valueOf()){database.prepare("UPDATE invoice_payment_drafts SET status='EXPIRED' WHERE id=?").run(draft.id);return{status:'EXPIRED',invoiceId:draft.invoice_id};}
    if(draft.requesting_user!==confirmingUser)throw new Error('CONFIRMING_USER_MISMATCH');if(draft.source_channel!==sourceChannel||draft.source_chat!==sourceChat)throw new Error('CONFIRMATION_CONTEXT_MISMATCH');
    const invoice=database.prepare('SELECT * FROM invoices WHERE id=?').get(draft.invoice_id);if(!invoice||invoice.status!=='ISSUED')throw new Error('INVOICE_NOT_ISSUED');
    if(invoice.amount_paid_minor!==draft.prior_amount_paid_minor||invoice.balance_due_minor!==draft.prior_balance_due_minor){database.prepare("UPDATE invoice_payment_drafts SET status='INVALIDATED' WHERE id=?").run(draft.id);return{status:'INVALIDATED',invoiceId:draft.invoice_id};}
    if(draft.amount_minor>invoice.balance_due_minor)throw new Error('OVERPAYMENT_BLOCKED');
    const amountPaid=invoice.amount_paid_minor+draft.amount_minor,balance=invoice.total_minor-amountPaid,paymentStatus=balance===0?'PAID':'PARTIALLY_PAID';
    database.prepare('UPDATE invoices SET amount_paid_minor=?,balance_due_minor=?,payment_status=?,paid_at=? WHERE id=?').run(amountPaid,balance,paymentStatus,paymentStatus==='PAID'?draft.payment_date:null,draft.invoice_id);
    database.prepare("UPDATE invoice_payment_drafts SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(now,draft.id);
    database.prepare(`INSERT INTO invoice_payment_events
      (invoice_id,payment_draft_id,amount_minor,prior_amount_paid_minor,new_amount_paid_minor,prior_balance_due_minor,new_balance_due_minor,prior_payment_status,new_payment_status,payment_date,payment_reference,actor,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(draft.invoice_id,draft.id,draft.amount_minor,invoice.amount_paid_minor,amountPaid,invoice.balance_due_minor,balance,invoice.payment_status,paymentStatus,draft.payment_date,draft.payment_reference,confirmingUser,now);
    database.prepare(`INSERT INTO audit_events (timestamp,actor,action,entity_type,entity_id,source_channel,source_chat,source_message_reference,result,details_json)
      VALUES (?,?,'invoice.payment_recorded','invoice',?,?,?,?, 'PASS',?)`).run(now,confirmingUser,draft.invoice_id,sourceChannel,sourceChat,draft.source_message_reference,canonicalJson({amountMinor:draft.amount_minor,newPaymentStatus:paymentStatus,newBalanceDueMinor:balance,referenceRecorded:Boolean(draft.payment_reference)}));
    return{status:'CONFIRMED',invoiceId:draft.invoice_id,amountPaidMinor:amountPaid,balanceDueMinor:balance,paymentStatus,paidAt:paymentStatus==='PAID'?draft.payment_date:null};
  });}finally{database.close();}
}
