# Templates

Phase F2 uses six DOCX templates: a quotation and invoice for each of MYR, SGD, and USD.

- `source/` contains byte-for-byte protected originals.
- `normalized/` contains generated working copies with approved placeholders.
- The initially supplied files remain under their currency directories as intake evidence.

All DOCX files in this tree are ignored by Git because they contain protected business and bank-display information. Only public-safe inventory, mappings, validation code, and documentation are committed.

Normalized copies enforce A4 portrait geometry, right-aligned monetary values, centered quantities, compact item spacing, and a maximum of seven item rows. Generated documents retain only the item rows actually used so short documents fit one page where possible.
