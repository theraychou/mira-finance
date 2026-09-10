import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SheetsClientError extends Error {
  constructor(code, { transient = false } = {}) {
    super(`Google Sheets operation failed (${code}).`);
    this.name = 'SheetsClientError';
    this.code = code;
    this.transient = transient;
  }
}

function classify(error) {
  const value = `${error?.message ?? ''} ${error?.stderr ?? ''}`.toLowerCase();
  if (/429|500|502|503|504|timeout|timed out|econnreset|enotfound|rate limit|temporar/.test(value)) {
    return new SheetsClientError('SHEETS_TRANSIENT_FAILURE', { transient: true });
  }
  if (/invalid_grant|unauthorized_client|insufficient|permission|forbidden|401|403/.test(value)) {
    return new SheetsClientError('SHEETS_AUTHORIZATION_FAILED');
  }
  if (/not found|404/.test(value)) return new SheetsClientError('SHEETS_ITEM_NOT_FOUND');
  return new SheetsClientError('SHEETS_COMMAND_FAILED');
}

function unwrap(payload) { return payload?.spreadsheet ?? payload?.file ?? payload?.result ?? payload; }

function spreadsheet(payload) {
  const value = unwrap(payload);
  const id = value?.spreadsheetId ?? value?.spreadsheet_id ?? value?.id;
  if (typeof id !== 'string' || !id) throw new SheetsClientError('SHEETS_RESPONSE_INVALID');
  return { id, url: value.spreadsheetUrl ?? value.spreadsheet_url ?? value.webViewLink ?? null };
}

function driveMetadata(payload) {
  const value = payload?.file ?? payload?.result ?? payload;
  if (!value || typeof value.id !== 'string') throw new SheetsClientError('SHEETS_RESPONSE_INVALID');
  return { id: value.id, parents: Array.isArray(value.parents) ? value.parents : [], mimeType: value.mimeType ?? value.mime_type ?? null };
}

export function createGogSheetsClient({ identity, client, gogCommand = 'gog', timeoutMs = 120000, runner = execFileAsync }) {
  if (typeof identity !== 'string' || !identity.includes('@')) throw new TypeError('Sheets identity is invalid.');
  if (typeof client !== 'string' || !client) throw new TypeError('Sheets client profile is required.');
  async function run(argumentsList) {
    try {
      const { stdout } = await runner(gogCommand, [
        `--account=${identity}`,
        `--client=${client}`,
        '--enable-commands=sheets,drive.get,drive.move',
        '--no-input',
        '--json',
        ...argumentsList
      ], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      if (error instanceof SheetsClientError) throw error;
      throw classify(error);
    }
  }
  return {
    async createSpreadsheet({ title, sheetName }) {
      return spreadsheet(await run(['sheets', 'create', title, `--sheets=${sheetName}`]));
    },
    async moveToFolder({ spreadsheetId, folderId }) {
      const before = driveMetadata(await run(['drive', 'get', spreadsheetId]));
      if (before.parents.includes(folderId)) return before;
      await run(['drive', 'move', spreadsheetId, `--parent=${folderId}`]);
      return driveMetadata(await run(['drive', 'get', spreadsheetId]));
    },
    async getMetadata(spreadsheetId) { return driveMetadata(await run(['drive', 'get', spreadsheetId])); },
    async updateValues({ spreadsheetId, range, values }) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-customer-sheet-'));
      const inputPath = path.join(directory, 'values.json');
      try {
        await writeFile(inputPath, JSON.stringify(values), { flag: 'wx', mode: 0o600 });
        await run(['sheets', 'update', spreadsheetId, range, '--values-json', `@${inputPath}`]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    async clearValues({ spreadsheetId, range }) { await run(['sheets', 'clear', spreadsheetId, range]); },
    async format({ spreadsheetId, range, format, fields }) {
      await run(['sheets', 'format', spreadsheetId, range, `--format-json=${JSON.stringify(format)}`, `--format-fields=${fields}`]);
    },
    async freeze({ spreadsheetId, rows, columns }) {
      await run(['sheets', 'freeze', spreadsheetId, `--rows=${rows}`, `--cols=${columns}`]);
    },
    async autoResize({ spreadsheetId, range }) { await run(['sheets', 'resize-columns', spreadsheetId, range, '--auto']); }
  };
}
