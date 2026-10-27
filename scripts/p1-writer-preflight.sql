SELECT CASE
  WHEN (SELECT count(*) FROM (VALUES
  ('20260629154204_init', '6dea7258d35ae19d5a76e5f574e494482fa4d0dc6f2393fb50fc3cd93a184b15'),
  ('20260629163909_nomenclature_stock', '0e33053f6a41acd850636ffcf6cb34413a52e29f2f8d07df10b6feaacf7e9a84'),
  ('20260630152734_autorule_fields', 'b2b5dd5b622403ca4eb413d196c5be4c32e7199a30f0c5963fed8b3a2add73b0'),
  ('20260630161618_statement_import_fields', 'ed341e65eab2034fddd68c2d89d730adc87e079aa72a0fd77fe518eacedfb67d'),
  ('20260630164144_cashflow_import_key', 'cb0fcc97b97f66bd960611ce60b09dee46a46f04c69c3c53d5c89b0df0cb82ed'),
  ('20260630190300_batch_name_unique', '01ca875e78cfa08102b0c790aa39c5519d1f806fbefb2d3b990df6df1ea11ea7'),
  ('20260630193000_batch_frozen_at', 'b9e56270f03cfca652aaa21dc29b455256a36e982fdf6cf4ec44f0e016407ec6'),
  ('20260701110000_operation_stock_provenance', '732f2565fae02a93105b323c0e921551be7593cf71853382fffa0caf48734655'),
  ('20260701120400_notifications', '7d50728b4621fbeb5547c01125628237b955ea55cc1d02b7e29edb101b636cf7'),
  ('20260701155446_marketplace_supply', '758118429cda9967258eb739c6f4b30e609ceafd9fa3f61cd19f4821d181764d'),
  ('20260701161500_supply_deduct_stock', '27d23e4178ffea3a8a58a5bbbe6d3ac8dcb4463cacb45d955e13749da390a2b4'),
  ('20260701180000_system_log', '473257af574c530dc1ad23acdfeb724038e17bb3d2cfef7eed02e35cd185fbe3'),
  ('20260701180500_supply_shortfall_qty', '86379bf88e4d12f13795e8e80da8f2dbd3fc1ab6d36e6dcae8e1858f4b8e6436'),
  ('20260702200000_cashflow_transfer', 'bc6d2698ff71c267cabe2d987958ee578a0350ab1ef6ceca5d89eb664cdc3d0f'),
  ('20260702210740_account_opening_balance', 'caaa10b39dc00dbba741db1a21f583a44187438f2602a9b993b1b7376d7e263e'),
  ('20260703081432_statement_balances', 'df6da41d4b74e0ecdab22170ddcf4fbe4bf9e070d4473a6c53c0e84dcaa66065'),
  ('20260703082744_account_confirmed', '2c988155793dfa2a7d971365be5ccf48c585d12a7ad4bfac0b3e473c1e7e18d0'),
  ('20260703220000_account_primary', '293f24ef3719b303a0e490ac6c66708db99e32ecbf3e9c5d217c4df6574bbe7a'),
  ('20260706130000_product_dual_sku', 'a774f4176d42ded9f73eda6fb646703cc3566b5d9d53fb89da4eaa1e2954037c'),
  ('20260707140000_detail_number', '9a343856d50eb302d80c11f3e9721e70aa9030280d14998fbcf43b6b8a729d3c'),
  ('20260710160000_blank_flow_detail_number', 'c5dae6bdb036ff13ca09b64a9f001edec185cbce648e23d8a1f689b5c6e569f6'),
  ('20260710200000_drop_product_saleprice', 'e175290bf6d8e260605bf0b9e737d2ba90d3356eea9ed8db1f47826c9f2724d5'),
  ('20260711120000_material', 'e91fcc8107295bcef65210cc1bc6ca57211fc347b31fa25f9cc129116b6682dc'),
  ('20260713161800_add_operation_client_request_id', '8a25801594e1bc4c257c3c749c6fdd054c4ec1cb71ee1f7787159d5ee4db606b'),
  ('20260713190000_detail_number_not_unique', '733ae5d974d0ead3acccd37ae7ffa7840a9b9c5dd779ed1ea1814c78d2753400'),
  ('20260724170000_material_section', 'c1e1522c86ca127ecbc5c68c121bf0001595c90480ef43b86aaab787f6f76922'),
  ('20260904150000_di003_account_number_import_key_unique', '7d83d519ef35d5062cb32cf97736be8b37d2f1ae241f46fa5a8417be3b117521'),
  ('20260904151000_di010_active_sku_unique', 'efca7c124d69c4133abcd20545b7127af0f0856724c967bec4a81232b0f08e1c'),
  ('20260904170000_batchcost_final_unique', '9c044997db2b1c37ec126dddb758f3c1e5b36b4af07993442e02df4449e5d9f9'),
  ('20260904180000_torcovka_waste_ack', 'f09a2417519a6e831d0c0cf7116d10202d7542038016c1d61dbace3b406034a2'),
  ('20260905160000_di016_inventory_single_draft', '549ecd8e06218f39bd792679a9ea3ea0e1ffa6f73ffe63cccc37af73d0f210cb'),
  ('20260905170000_production_operation_client_request_id_not_null', '0c140a16d465bbe352127c3ef84c31b20728221ff6cc2ad336ab8c85385a7182'),
  ('20260905210000_torcovka_approval', '6a2369fe5b1ac156295b23fd8ca91d7ba26d3ab76dad997dd5459941348793f9'),
  ('20260905220000_payment_batch_item_operation_unique', '2a145d67304f95fd8cac50bff068d8a4116ba4ff18668cd1e11811e01bec471e'),
  ('20260906013000_operation_rate_snapshots', '7be8b1368e1adfd8d3905803585ff69f78c0bdab2fce4c27f5becdd181827bc6'),
  ('20260907211500_cost_flow_foundation', '82bd4b413cf398245ed8d9d7248f45c1901402e09403686ef63d0e267e53f0ce'),
  ('20260907223000_cost_flow_foundation_constraints', '67c5b62506c8a6fee52a31457b9ec40bfb3d609898bb36dbb83964c7532a250d'),
  ('20260917150000_psr_p1_inventory_movement_shadow', '73d3a9118a5e28fc3419f601e44f66198677599922e4de430272b241958cba42'),
  ('20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz', 'bdff9b0fe07a571e6c8ae60aa460bf4ce7164291bdd0a0e65123a97dc0d8f1f7'),
  ('20260917200000_psr_p2_r04_supply_stock_accounting_cycle', '7ee1ecbd07f6c5057f421e93e8a37c4c90bf57f9f32d5f76013907914cefc494'),
  ('20260918120000_psr_p2_r05_production_operation_correction', 'bf505f71a3e08604826338c693e45df216116f52ec835898cfd88989b4940414'),
  ('20260918130000_psr_p2_r06_inventory_line_identity', 'cde195905774552909682a6294162a3bb740d0a21457fd6ef5c4d5092d75b4ca'),
  ('20260920120000_psr_p2_raw_identity_prerequisite', '0d436eed57ba2e6aa6f313f3a121fc33ed3a6c884339ce8ce441db1b5301bf62'),
  ('20260920180000_psr_p2_production_quantity_edit_identity', '997fcb0caf5f57f3514aa981976c72122f0c09e35a408922f1baea5df1a51a61'),
  ('20261008120000_upakovka_recovery_receipt', '7a243476d0dc561dde1e31d11db16613996a3d5e0a88af7695a6b48950cc3c54'),
  ('20261010210000_psr_p3_s2_b_batch_receipt_provenance', '47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5'),
  ('20261025120000_admin_corrections_batch_and_cancel', 'd8d83b48d536bd42cb9f394958dc981003d43da5b5904bcecadd3899b179f834')
  ) AS expected(migration_name, checksum)) = 47
  AND (
    SELECT count(*) FROM public."_prisma_migrations"
  ) = 47
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
  ('20260629154204_init', '6dea7258d35ae19d5a76e5f574e494482fa4d0dc6f2393fb50fc3cd93a184b15'),
  ('20260629163909_nomenclature_stock', '0e33053f6a41acd850636ffcf6cb34413a52e29f2f8d07df10b6feaacf7e9a84'),
  ('20260630152734_autorule_fields', 'b2b5dd5b622403ca4eb413d196c5be4c32e7199a30f0c5963fed8b3a2add73b0'),
  ('20260630161618_statement_import_fields', 'ed341e65eab2034fddd68c2d89d730adc87e079aa72a0fd77fe518eacedfb67d'),
  ('20260630164144_cashflow_import_key', 'cb0fcc97b97f66bd960611ce60b09dee46a46f04c69c3c53d5c89b0df0cb82ed'),
  ('20260630190300_batch_name_unique', '01ca875e78cfa08102b0c790aa39c5519d1f806fbefb2d3b990df6df1ea11ea7'),
  ('20260630193000_batch_frozen_at', 'b9e56270f03cfca652aaa21dc29b455256a36e982fdf6cf4ec44f0e016407ec6'),
  ('20260701110000_operation_stock_provenance', '732f2565fae02a93105b323c0e921551be7593cf71853382fffa0caf48734655'),
  ('20260701120400_notifications', '7d50728b4621fbeb5547c01125628237b955ea55cc1d02b7e29edb101b636cf7'),
  ('20260701155446_marketplace_supply', '758118429cda9967258eb739c6f4b30e609ceafd9fa3f61cd19f4821d181764d'),
  ('20260701161500_supply_deduct_stock', '27d23e4178ffea3a8a58a5bbbe6d3ac8dcb4463cacb45d955e13749da390a2b4'),
  ('20260701180000_system_log', '473257af574c530dc1ad23acdfeb724038e17bb3d2cfef7eed02e35cd185fbe3'),
  ('20260701180500_supply_shortfall_qty', '86379bf88e4d12f13795e8e80da8f2dbd3fc1ab6d36e6dcae8e1858f4b8e6436'),
  ('20260702200000_cashflow_transfer', 'bc6d2698ff71c267cabe2d987958ee578a0350ab1ef6ceca5d89eb664cdc3d0f'),
  ('20260702210740_account_opening_balance', 'caaa10b39dc00dbba741db1a21f583a44187438f2602a9b993b1b7376d7e263e'),
  ('20260703081432_statement_balances', 'df6da41d4b74e0ecdab22170ddcf4fbe4bf9e070d4473a6c53c0e84dcaa66065'),
  ('20260703082744_account_confirmed', '2c988155793dfa2a7d971365be5ccf48c585d12a7ad4bfac0b3e473c1e7e18d0'),
  ('20260703220000_account_primary', '293f24ef3719b303a0e490ac6c66708db99e32ecbf3e9c5d217c4df6574bbe7a'),
  ('20260706130000_product_dual_sku', 'a774f4176d42ded9f73eda6fb646703cc3566b5d9d53fb89da4eaa1e2954037c'),
  ('20260707140000_detail_number', '9a343856d50eb302d80c11f3e9721e70aa9030280d14998fbcf43b6b8a729d3c'),
  ('20260710160000_blank_flow_detail_number', 'c5dae6bdb036ff13ca09b64a9f001edec185cbce648e23d8a1f689b5c6e569f6'),
  ('20260710200000_drop_product_saleprice', 'e175290bf6d8e260605bf0b9e737d2ba90d3356eea9ed8db1f47826c9f2724d5'),
  ('20260711120000_material', 'e91fcc8107295bcef65210cc1bc6ca57211fc347b31fa25f9cc129116b6682dc'),
  ('20260713161800_add_operation_client_request_id', '8a25801594e1bc4c257c3c749c6fdd054c4ec1cb71ee1f7787159d5ee4db606b'),
  ('20260713190000_detail_number_not_unique', '733ae5d974d0ead3acccd37ae7ffa7840a9b9c5dd779ed1ea1814c78d2753400'),
  ('20260724170000_material_section', 'c1e1522c86ca127ecbc5c68c121bf0001595c90480ef43b86aaab787f6f76922'),
  ('20260904150000_di003_account_number_import_key_unique', '7d83d519ef35d5062cb32cf97736be8b37d2f1ae241f46fa5a8417be3b117521'),
  ('20260904151000_di010_active_sku_unique', 'efca7c124d69c4133abcd20545b7127af0f0856724c967bec4a81232b0f08e1c'),
  ('20260904170000_batchcost_final_unique', '9c044997db2b1c37ec126dddb758f3c1e5b36b4af07993442e02df4449e5d9f9'),
  ('20260904180000_torcovka_waste_ack', 'f09a2417519a6e831d0c0cf7116d10202d7542038016c1d61dbace3b406034a2'),
  ('20260905160000_di016_inventory_single_draft', '549ecd8e06218f39bd792679a9ea3ea0e1ffa6f73ffe63cccc37af73d0f210cb'),
  ('20260905170000_production_operation_client_request_id_not_null', '0c140a16d465bbe352127c3ef84c31b20728221ff6cc2ad336ab8c85385a7182'),
  ('20260905210000_torcovka_approval', '6a2369fe5b1ac156295b23fd8ca91d7ba26d3ab76dad997dd5459941348793f9'),
  ('20260905220000_payment_batch_item_operation_unique', '2a145d67304f95fd8cac50bff068d8a4116ba4ff18668cd1e11811e01bec471e'),
  ('20260906013000_operation_rate_snapshots', '7be8b1368e1adfd8d3905803585ff69f78c0bdab2fce4c27f5becdd181827bc6'),
  ('20260907211500_cost_flow_foundation', '82bd4b413cf398245ed8d9d7248f45c1901402e09403686ef63d0e267e53f0ce'),
  ('20260907223000_cost_flow_foundation_constraints', '67c5b62506c8a6fee52a31457b9ec40bfb3d609898bb36dbb83964c7532a250d'),
  ('20260917150000_psr_p1_inventory_movement_shadow', '73d3a9118a5e28fc3419f601e44f66198677599922e4de430272b241958cba42'),
  ('20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz', 'bdff9b0fe07a571e6c8ae60aa460bf4ce7164291bdd0a0e65123a97dc0d8f1f7'),
  ('20260917200000_psr_p2_r04_supply_stock_accounting_cycle', '7ee1ecbd07f6c5057f421e93e8a37c4c90bf57f9f32d5f76013907914cefc494'),
  ('20260918120000_psr_p2_r05_production_operation_correction', 'bf505f71a3e08604826338c693e45df216116f52ec835898cfd88989b4940414'),
  ('20260918130000_psr_p2_r06_inventory_line_identity', 'cde195905774552909682a6294162a3bb740d0a21457fd6ef5c4d5092d75b4ca'),
  ('20260920120000_psr_p2_raw_identity_prerequisite', '0d436eed57ba2e6aa6f313f3a121fc33ed3a6c884339ce8ce441db1b5301bf62'),
  ('20260920180000_psr_p2_production_quantity_edit_identity', '997fcb0caf5f57f3514aa981976c72122f0c09e35a408922f1baea5df1a51a61'),
  ('20261008120000_upakovka_recovery_receipt', '7a243476d0dc561dde1e31d11db16613996a3d5e0a88af7695a6b48950cc3c54'),
  ('20261010210000_psr_p3_s2_b_batch_receipt_provenance', '47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5'),
  ('20261025120000_admin_corrections_batch_and_cancel', 'd8d83b48d536bd42cb9f394958dc981003d43da5b5904bcecadd3899b179f834')
    ) AS expected(migration_name, checksum)
    FULL OUTER JOIN public."_prisma_migrations" AS applied
      ON applied.migration_name = expected.migration_name
    WHERE expected.migration_name IS NULL
      OR applied.migration_name IS NULL
      OR applied.checksum IS DISTINCT FROM expected.checksum
      OR applied.started_at IS NULL
      OR applied.finished_at IS NULL
      OR applied.rolled_back_at IS NOT NULL
      OR applied.applied_steps_count IS DISTINCT FROM 1
  )
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND a.attname = 'receiptProvenanceSnapshot'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND t.typname = 'jsonb'
      AND NOT a.attnotnull
      AND a.attidentity = ''
      AND a.attgenerated = ''
      AND a.attcollation = 0
      AND ad.adbin IS NULL
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
      AND con.contype = 'c'
      AND con.convalidated
      AND NOT con.condeferrable
      AND NOT con.condeferred
      AND pg_catalog.pg_get_constraintdef(con.oid, true) = 'CHECK ("receiptProvenanceSnapshot" IS NULL OR jsonb_typeof("receiptProvenanceSnapshot") = ''object''::text)'
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND p.proname = 'batch_creation_command_provenance_guard'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
      AND l.lanname = 'plpgsql'
      AND NOT p.prosecdef
      AND btrim(pg_catalog.pg_get_functiondef(p.oid)) = btrim($p1fn$CREATE OR REPLACE FUNCTION public.batch_creation_command_provenance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'batch creation command provenance is retained';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."receiptProvenanceSnapshot" IS NULL THEN
    IF NEW."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'legacy batch creation command provenance cannot be filled';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."receiptProvenanceSnapshot" IS DISTINCT FROM OLD."receiptProvenanceSnapshot"
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId" THEN
    RAISE EXCEPTION 'batch creation command provenance is immutable';
  END IF;

  RETURN NEW;
END;
$function$
$p1fn$)
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc AS fp ON fp.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace AS fn ON fn.oid = fp.pronamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname = 'batch_creation_command_provenance_guard'
      AND t.tgenabled = 'O'
      AND fn.nspname = 'public'
      AND fp.proname = 'batch_creation_command_provenance_guard'
      AND pg_catalog.pg_get_function_identity_arguments(fp.oid) = ''
      AND pg_catalog.pg_get_triggerdef(t.oid, true) = 'CREATE TRIGGER batch_creation_command_provenance_guard BEFORE DELETE OR UPDATE ON "BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION batch_creation_command_provenance_guard()'
  ) = 1
  THEN 'P1_APPLIED'
  ELSE 'P1_BLOCKED'
END AS writer_verdict;
