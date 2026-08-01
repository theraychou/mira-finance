# Mira tools

Phase F17A exposes the no-argument `mira_finance_health` tool plus two narrowly scoped outbound-delivery tools. `mira_finance_prepare_delivery` creates a masked preview and short-lived token for one verified contact and one immutable issued PDF. `mira_finance_confirm_delivery` consumes that exact token and sends once. The broad `message` tool remains denied. Receipt, claim, supplier-registry, incoming supplier-invoice, reporting, export, claim-recharge, claim-pack, correction, recovery, restore-drill, maintenance, and contact mutations remain fail-closed local administrator operations. Inbound email and WhatsApp reply processing is not enabled in F17A.

Never record credentials, bank details, customer data, Google identifiers, WhatsApp identifiers, or Jessie workspace information in this file.
