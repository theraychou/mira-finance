import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomerSheetMirrorConfiguration } from '../../scripts/lib/customer-sheet-mirror-config.mjs';

test('customer Sheet configuration is disabled safely and requires exact private identifiers when enabled', () => {
  const disabled = validateCustomerSheetMirrorConfiguration({ $schema: '../schemas/customer-sheet-mirror.schema.json', schemaVersion: 1, enabled: false, identity: null, client: null,
    folderId: null, spreadsheetTitle: 'Mira Customer Register', sheetName: 'Customers' });
  assert.equal(disabled.enabled, false);
  assert.throws(() => validateCustomerSheetMirrorConfiguration({ ...disabled, enabled: true }), /identity/);
  const enabled = validateCustomerSheetMirrorConfiguration({ ...disabled, enabled: true, identity: 'test@example.invalid',
    client: 'mira-sheets', folderId: 'TEST_FOLDER_123456' });
  assert.equal(enabled.folderId, 'TEST_FOLDER_123456');
});
