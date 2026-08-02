import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function string(value) { return typeof value === 'string' ? value : null; }
function receivedAt(item) {
  const candidate = string(item.receivedAt ?? item.internalDateTime ?? item.date);
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  if (item.internalDate != null && !Number.isNaN(Number(item.internalDate))) return new Date(Number(item.internalDate)).toISOString();
  throw new Error('EMAIL_RECEIVED_AT_INVALID');
}
function messages(value) {
  const list = Array.isArray(value) ? value : value?.messages ?? value?.results ?? value?.items ?? [];
  if (!Array.isArray(list)) throw new Error('EMAIL_SEARCH_RESPONSE_INVALID');
  return list.map((item) => ({
    id: string(item.id ?? item.messageId ?? item.message_id),
    threadId: string(item.threadId ?? item.thread_id),
    from: string(item.from ?? item.sender ?? item.headers?.from),
    subject: string(item.subject ?? item.headers?.subject) ?? '',
    body: string(item.body ?? item.text ?? item.bodyText ?? item.snippet),
    receivedAt: receivedAt(item),
    hasAttachments: Boolean(item.hasAttachments ?? item.attachments?.length)
  })).filter((item) => item.id && item.from && item.body);
}

export function createGogGmailInboundClient({ account, client, gogCommand = 'gog', timeoutMs = 120000, runner = execFileAsync }) {
  if (!account || !client) throw new TypeError('account and client are required.');
  return {
    async search({ query, maximumResults }) {
      const args = [`--account=${account}`, `--client=${client}`, '--enable-commands=gmail', '--no-input', '--json',
        'gmail', 'messages', 'search', query, '--include-body', `--max=${maximumResults}`];
      const { stdout } = await runner(gogCommand, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return messages(JSON.parse(stdout));
    }
  };
}
