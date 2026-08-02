import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WhatsAppDeliveryError extends Error {
  constructor(code) {
    super(`WhatsApp delivery failed (${code}).`);
    this.name = 'WhatsAppDeliveryError';
    this.code = code;
  }
}

function classify(error) {
  const value = `${error?.message ?? ''} ${error?.stderr ?? ''}`.toLowerCase();
  if (/not linked|logged out|auth|unauthor|forbidden|401|403/.test(value)) return new WhatsAppDeliveryError('WHATSAPP_AUTHORIZATION_FAILED');
  if (/429|500|502|503|504|timeout|timed out|econnreset|enotfound|rate limit|temporar|gateway.*unavailable/.test(value)) return new WhatsAppDeliveryError('WHATSAPP_TRANSIENT_FAILURE');
  if (/invalid.*target|recipient|jid/.test(value)) return new WhatsAppDeliveryError('WHATSAPP_RECIPIENT_REJECTED');
  return new WhatsAppDeliveryError('WHATSAPP_DELIVERY_FAILED');
}

export function createOpenClawWhatsAppClient({
  account = null,
  openClawCommand = 'openclaw',
  timeoutMs = 120000,
  runner = execFileAsync
} = {}) {
  async function invoke({ to, body, attachmentPath = null }) {
    const argumentsList = ['message', 'send', '--channel=whatsapp', `--target=${to}`, `--message=${body}`, '--json'];
    if (attachmentPath) argumentsList.splice(argumentsList.length - 1, 0, `--media=${attachmentPath}`);
    if (account) argumentsList.push(`--account=${account}`);
    try {
      const { stdout } = await runner(openClawCommand, argumentsList, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      const reference = result?.messageId ?? result?.message_id ?? result?.id ?? result?.result?.messageId;
      if (typeof reference !== 'string' || reference.length === 0) throw new WhatsAppDeliveryError('WHATSAPP_RESPONSE_INVALID');
      return { providerReference: reference };
    } catch (error) {
      if (error instanceof WhatsAppDeliveryError) throw error;
      throw classify(error);
    }
  }
  return {
    async send({ to, body, attachmentPath }) {
      return invoke({ to, body, attachmentPath });
    },
    async reply({ to, body }) { return invoke({ to, body }); },
    async notify({ to, body }) { return invoke({ to, body }); }
  };
}
