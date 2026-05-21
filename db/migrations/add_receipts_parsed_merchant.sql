-- Store the merchant name the parser pulled off the receipt image so orphan
-- (unlinked) receipts can be identified in the history list and used as a
-- search hint when linking to a restaurant later.

alter table receipts
  add column if not exists parsed_merchant text;
