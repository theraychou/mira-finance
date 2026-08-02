import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GmailDeliveryError extends Error {
  constructor(code) {
    super(`Gmail delivery failed (${code}).`);
    this.name = 'GmailDeliveryError';
    this.code = code;
  }
}

function classify(error) {
  const value = `${error?.message ?? ''} ${error?.stderr ?? ''}`.toLowerCase();
  if (/invalid_grant|unauthorized_client|insufficient|permission|forbidden|401|403/.test(value)) return new GmailDeliveryError('EMAIL_AUTHORIZATION_FAILED');
  if (/429|500|502|503|504|timeout|timed out|econnreset|enotfound|rate limit|temporar/.test(value)) return new GmailDeliveryError('EMAIL_TRANSIENT_FAILURE');
  if (/recipient|address|invalid.*email/.test(value)) return new GmailDeliveryError('EMAIL_RECIPIENT_REJECTED');
  return new GmailDeliveryError('EMAIL_DELIVERY_FAILED');
}

export function createGogGmailClient({
  account,
  client,
  from,
  replyTo = null,
  gogCommand = 'gog',
  timeoutMs = 120000,
  runner = execFileAsync
}) {
  for (const [name, value] of Object.entries({ account, client, from })) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  }
  return {
    async send({ to, subject, body, attachmentPath }) {
      const argumentsList = [
        `--account=${account}`,
        `--client=${client}`,
        '--enable-commands=gmail',
        '--no-input',
        '--json',
        'gmail',
        'send',
        `--to=${to}`,
        `--from=${from}`,
        `--subject=${subject}`,
        `--body=${body}`,
        `--attach=${attachmentPath}`
      ];
      if (replyTo) argumentsList.push(`--reply-to=${replyTo}`);
      try {
        const { stdout } = await runner(gogCommand, argumentsList, {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        });
        const result = JSON.parse(stdout);
        const reference = result?.id ?? result?.messageId ?? result?.message_id ?? result?.message?.id;
        if (typeof reference !== 'string' || reference.length === 0) throw new GmailDeliveryError('EMAIL_RESPONSE_INVALID');
        return { providerReference: reference };
      } catch (error) {
        if (error instanceof GmailDeliveryError) throw error;
        throw classify(error);
      }
    },
    async reply({ to, subject, body, inReplyTo, threadId }) {
      const replySubject = /^re:/i.test(subject ?? '') ? subject : `Re: ${subject || 'Your finance document'}`;
      const argumentsList = [
        `--account=${account}`, `--client=${client}`, '--enable-commands=gmail', '--no-input', '--json',
        'gmail', 'send', `--to=${to}`, `--from=${from}`, `--subject=${replySubject}`, `--body=${body}`
      ];
      if (inReplyTo) argumentsList.push(`--reply-to-message-id=${inReplyTo}`);
      else if (threadId) argumentsList.push(`--thread-id=${threadId}`);
      if (replyTo) argumentsList.push(`--reply-to=${replyTo}`);
      try {
        const { stdout } = await runner(gogCommand, argumentsList, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(stdout);
        const reference = result?.id ?? result?.messageId ?? result?.message_id ?? result?.message?.id;
        if (typeof reference !== 'string' || !reference) throw new GmailDeliveryError('EMAIL_RESPONSE_INVALID');
        return { providerReference: reference };
      } catch (error) {
        if (error instanceof GmailDeliveryError) throw error;
        throw classify(error);
      }
    }
  };
}
