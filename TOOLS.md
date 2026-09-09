# Mira tools

Phase F18 retains the health, confirmation-gated outbound-delivery, and customer-reply tools. It adds `mira_finance_prepare_invoice` and `mira_finance_confirm_invoice` for deterministic standalone invoice preparation and confirmed issuance from Ray in RC Finance. The prepare tool accepts decimal price strings and converts them to integer minor units; the confirm tool accepts only the exact bound token. Direct verified-contact WhatsApp handling and bounded Gmail polling remain plugin/operations paths. The broad `message` and `exec` tools remain denied. Customer text cannot invoke tools or change finance state.

Never record credentials, bank details, customer data, Google identifiers, WhatsApp identifiers, or Jessie workspace information in this file.
