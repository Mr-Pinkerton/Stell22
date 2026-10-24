/* Generated from src/server/internal/p1-production-release/plan-entry.ts. Do not edit. */
"use strict";

// src/server/internal/p1-production-release/plan-entry.ts
var import_node_fs = require("node:fs");

// src/server/internal/p1-isolated-runner/contract.ts
var P1_MIGRATION_NAME = "20261010210000_psr_p3_s2_b_batch_receipt_provenance";
var P1_SHA256 = "47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5";
var EXPECTED_HISTORICAL_MIGRATION_COUNT = 45;
var FORBIDDEN_DATABASE_NAMES = [
  "stell22",
  "stell22_integrity",
  "stell22_dev",
  "postgres",
  "template0",
  "template1"
];
var FORBIDDEN_CONTAINER_IDENTIFIERS = [
  "stell22-db-prod",
  "stell22-app",
  "stell22-caddy"
];

// src/server/internal/p1-isolated-runner/inventory.ts
var PINNED_MIGRATION_FILES = [
  {
    path: "prisma/migrations/20260629154204_init/migration.sql",
    gitBlob: "792d4469c996afb5ab085716c5fc1de529a1db86",
    sha256: "6dea7258d35ae19d5a76e5f574e494482fa4d0dc6f2393fb50fc3cd93a184b15"
  },
  {
    path: "prisma/migrations/20260629163909_nomenclature_stock/migration.sql",
    gitBlob: "6646aa68cf407b42f7ef5f77de12d4de40fc1a9f",
    sha256: "0e33053f6a41acd850636ffcf6cb34413a52e29f2f8d07df10b6feaacf7e9a84"
  },
  {
    path: "prisma/migrations/20260630152734_autorule_fields/migration.sql",
    gitBlob: "21ad16de7bb8425ba1ae0b7138dbec8af124ba9f",
    sha256: "b2b5dd5b622403ca4eb413d196c5be4c32e7199a30f0c5963fed8b3a2add73b0"
  },
  {
    path: "prisma/migrations/20260630161618_statement_import_fields/migration.sql",
    gitBlob: "84754901063689c5360e473a1253ad5ea8c07b1c",
    sha256: "ed341e65eab2034fddd68c2d89d730adc87e079aa72a0fd77fe518eacedfb67d"
  },
  {
    path: "prisma/migrations/20260630164144_cashflow_import_key/migration.sql",
    gitBlob: "4653f5fc32c3a402314102b6491fce7f5732fe5d",
    sha256: "cb0fcc97b97f66bd960611ce60b09dee46a46f04c69c3c53d5c89b0df0cb82ed"
  },
  {
    path: "prisma/migrations/20260630190300_batch_name_unique/migration.sql",
    gitBlob: "448ff42545e6994cb0cb88daf79107fead02295e",
    sha256: "01ca875e78cfa08102b0c790aa39c5519d1f806fbefb2d3b990df6df1ea11ea7"
  },
  {
    path: "prisma/migrations/20260630193000_batch_frozen_at/migration.sql",
    gitBlob: "32e5016392c0a826b74ba2fca63b525bda79157c",
    sha256: "b9e56270f03cfca652aaa21dc29b455256a36e982fdf6cf4ec44f0e016407ec6"
  },
  {
    path: "prisma/migrations/20260701110000_operation_stock_provenance/migration.sql",
    gitBlob: "b5396cfc68b41b2e34aa05d55c2a5eb85c2daa55",
    sha256: "732f2565fae02a93105b323c0e921551be7593cf71853382fffa0caf48734655"
  },
  {
    path: "prisma/migrations/20260701120400_notifications/migration.sql",
    gitBlob: "846e7ee712571248ddea49bc2886c972fd56f499",
    sha256: "7d50728b4621fbeb5547c01125628237b955ea55cc1d02b7e29edb101b636cf7"
  },
  {
    path: "prisma/migrations/20260701155446_marketplace_supply/migration.sql",
    gitBlob: "975f2343466765575a7225b880a35fa3795ae5b1",
    sha256: "758118429cda9967258eb739c6f4b30e609ceafd9fa3f61cd19f4821d181764d"
  },
  {
    path: "prisma/migrations/20260701161500_supply_deduct_stock/migration.sql",
    gitBlob: "90da208335348bc105464e4eb87faa86751932d5",
    sha256: "27d23e4178ffea3a8a58a5bbbe6d3ac8dcb4463cacb45d955e13749da390a2b4"
  },
  {
    path: "prisma/migrations/20260701180000_system_log/migration.sql",
    gitBlob: "06748b812c8df46f01ac13be785696a40c17b3eb",
    sha256: "473257af574c530dc1ad23acdfeb724038e17bb3d2cfef7eed02e35cd185fbe3"
  },
  {
    path: "prisma/migrations/20260701180500_supply_shortfall_qty/migration.sql",
    gitBlob: "54eeb7a2784b723048eca771d0c2e1380eaae797",
    sha256: "86379bf88e4d12f13795e8e80da8f2dbd3fc1ab6d36e6dcae8e1858f4b8e6436"
  },
  {
    path: "prisma/migrations/20260702200000_cashflow_transfer/migration.sql",
    gitBlob: "1c414ceaec02cc647169ea4c3a89f9f2c9438b21",
    sha256: "bc6d2698ff71c267cabe2d987958ee578a0350ab1ef6ceca5d89eb664cdc3d0f"
  },
  {
    path: "prisma/migrations/20260702210740_account_opening_balance/migration.sql",
    gitBlob: "7024412aa93c2d673fe604fe690358f5630de1a8",
    sha256: "caaa10b39dc00dbba741db1a21f583a44187438f2602a9b993b1b7376d7e263e"
  },
  {
    path: "prisma/migrations/20260703081432_statement_balances/migration.sql",
    gitBlob: "018b0d300d201574bcde649a72025edd43585536",
    sha256: "df6da41d4b74e0ecdab22170ddcf4fbe4bf9e070d4473a6c53c0e84dcaa66065"
  },
  {
    path: "prisma/migrations/20260703082744_account_confirmed/migration.sql",
    gitBlob: "7b2c7d05ca071aaba1c3273f21420fc56c2cbcc5",
    sha256: "2c988155793dfa2a7d971365be5ccf48c585d12a7ad4bfac0b3e473c1e7e18d0"
  },
  {
    path: "prisma/migrations/20260703220000_account_primary/migration.sql",
    gitBlob: "eb672196a1d2992d69dbe09edd0f89fa8b014bff",
    sha256: "293f24ef3719b303a0e490ac6c66708db99e32ecbf3e9c5d217c4df6574bbe7a"
  },
  {
    path: "prisma/migrations/20260706130000_product_dual_sku/migration.sql",
    gitBlob: "f78b66490c41a112cc8605ec5daf98b189a8bbf7",
    sha256: "a774f4176d42ded9f73eda6fb646703cc3566b5d9d53fb89da4eaa1e2954037c"
  },
  {
    path: "prisma/migrations/20260707140000_detail_number/migration.sql",
    gitBlob: "4eaf96b3b1e728cd6f1d13c2fcd78a24667c0523",
    sha256: "9a343856d50eb302d80c11f3e9721e70aa9030280d14998fbcf43b6b8a729d3c"
  },
  {
    path: "prisma/migrations/20260710160000_blank_flow_detail_number/migration.sql",
    gitBlob: "2ce3b6b4f22d387ee238a3be48241757591082af",
    sha256: "c5dae6bdb036ff13ca09b64a9f001edec185cbce648e23d8a1f689b5c6e569f6"
  },
  {
    path: "prisma/migrations/20260710200000_drop_product_saleprice/migration.sql",
    gitBlob: "ff78d36078337c9b2fcafa33851ad1dd95712f06",
    sha256: "e175290bf6d8e260605bf0b9e737d2ba90d3356eea9ed8db1f47826c9f2724d5"
  },
  {
    path: "prisma/migrations/20260711120000_material/migration.sql",
    gitBlob: "0b7f981f915556a99d587b25d9d371342b6bf90b",
    sha256: "e91fcc8107295bcef65210cc1bc6ca57211fc347b31fa25f9cc129116b6682dc"
  },
  {
    path: "prisma/migrations/20260713161800_add_operation_client_request_id/migration.sql",
    gitBlob: "e1a5aa44f1f7dbec06cefbfb57e55e9261be0d9a",
    sha256: "8a25801594e1bc4c257c3c749c6fdd054c4ec1cb71ee1f7787159d5ee4db606b"
  },
  {
    path: "prisma/migrations/20260713190000_detail_number_not_unique/migration.sql",
    gitBlob: "fc5ed152c928059a82b078d4d9db0bd43f83680e",
    sha256: "733ae5d974d0ead3acccd37ae7ffa7840a9b9c5dd779ed1ea1814c78d2753400"
  },
  {
    path: "prisma/migrations/20260724170000_material_section/migration.sql",
    gitBlob: "3d17dd52b4072482e35937d8dc188255cd648edc",
    sha256: "c1e1522c86ca127ecbc5c68c121bf0001595c90480ef43b86aaab787f6f76922"
  },
  {
    path: "prisma/migrations/20260904150000_di003_account_number_import_key_unique/migration.sql",
    gitBlob: "e9492dcdd2720cb44ca69e03c391174cbf95676c",
    sha256: "7d83d519ef35d5062cb32cf97736be8b37d2f1ae241f46fa5a8417be3b117521"
  },
  {
    path: "prisma/migrations/20260904151000_di010_active_sku_unique/migration.sql",
    gitBlob: "6eb63ee4f4b83d2762f74c10e4c0349413bdd0dc",
    sha256: "efca7c124d69c4133abcd20545b7127af0f0856724c967bec4a81232b0f08e1c"
  },
  {
    path: "prisma/migrations/20260904170000_batchcost_final_unique/migration.sql",
    gitBlob: "2ada2a775d0d96d1c1fa199eedb788b50ba8f225",
    sha256: "9c044997db2b1c37ec126dddb758f3c1e5b36b4af07993442e02df4449e5d9f9"
  },
  {
    path: "prisma/migrations/20260904180000_torcovka_waste_ack/migration.sql",
    gitBlob: "b431c58879c58d385d434b40deb32a07985084e9",
    sha256: "f09a2417519a6e831d0c0cf7116d10202d7542038016c1d61dbace3b406034a2"
  },
  {
    path: "prisma/migrations/20260905160000_di016_inventory_single_draft/migration.sql",
    gitBlob: "6866ab399acbbc127158388247d2a6dc4af8c8d0",
    sha256: "549ecd8e06218f39bd792679a9ea3ea0e1ffa6f73ffe63cccc37af73d0f210cb"
  },
  {
    path: "prisma/migrations/20260905170000_production_operation_client_request_id_not_null/migration.sql",
    gitBlob: "8ec2e2c0b311a62a628234eb150e735082da6119",
    sha256: "0c140a16d465bbe352127c3ef84c31b20728221ff6cc2ad336ab8c85385a7182"
  },
  {
    path: "prisma/migrations/20260905210000_torcovka_approval/migration.sql",
    gitBlob: "7b5309886f69ae79076ca04d707a99d007d1a4c7",
    sha256: "6a2369fe5b1ac156295b23fd8ca91d7ba26d3ab76dad997dd5459941348793f9"
  },
  {
    path: "prisma/migrations/20260905220000_payment_batch_item_operation_unique/migration.sql",
    gitBlob: "22679874b38a55feb068cd52783baa485e2c9e97",
    sha256: "2a145d67304f95fd8cac50bff068d8a4116ba4ff18668cd1e11811e01bec471e"
  },
  {
    path: "prisma/migrations/20260906013000_operation_rate_snapshots/migration.sql",
    gitBlob: "457d32200d82b667b20383526b069e18b5c277f8",
    sha256: "7be8b1368e1adfd8d3905803585ff69f78c0bdab2fce4c27f5becdd181827bc6"
  },
  {
    path: "prisma/migrations/20260907211500_cost_flow_foundation/migration.sql",
    gitBlob: "18a7a68909989eacef2296bb98ae02178d7cb489",
    sha256: "82bd4b413cf398245ed8d9d7248f45c1901402e09403686ef63d0e267e53f0ce"
  },
  {
    path: "prisma/migrations/20260907223000_cost_flow_foundation_constraints/migration.sql",
    gitBlob: "0aaacbf758fa229326bd6fe429d91a84b7a4a450",
    sha256: "67c5b62506c8a6fee52a31457b9ec40bfb3d609898bb36dbb83964c7532a250d"
  },
  {
    path: "prisma/migrations/20260917150000_psr_p1_inventory_movement_shadow/migration.sql",
    gitBlob: "7ab1c51723a54859e996118de1753a66a56e1cf0",
    sha256: "73d3a9118a5e28fc3419f601e44f66198677599922e4de430272b241958cba42"
  },
  {
    path: "prisma/migrations/20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz/migration.sql",
    gitBlob: "05ddad5fa0790648d3d80d23a89f1fca32771e14",
    sha256: "bdff9b0fe07a571e6c8ae60aa460bf4ce7164291bdd0a0e65123a97dc0d8f1f7"
  },
  {
    path: "prisma/migrations/20260917200000_psr_p2_r04_supply_stock_accounting_cycle/migration.sql",
    gitBlob: "b64a77eb23f901621174091695fe8e839cd0a1ca",
    sha256: "7ee1ecbd07f6c5057f421e93e8a37c4c90bf57f9f32d5f76013907914cefc494"
  },
  {
    path: "prisma/migrations/20260918120000_psr_p2_r05_production_operation_correction/migration.sql",
    gitBlob: "296f543c54b16d8b3acb0c276595c937bd3a3d7b",
    sha256: "bf505f71a3e08604826338c693e45df216116f52ec835898cfd88989b4940414"
  },
  {
    path: "prisma/migrations/20260918130000_psr_p2_r06_inventory_line_identity/migration.sql",
    gitBlob: "845fec38f79903716d5c0798fd7cb841900de57b",
    sha256: "cde195905774552909682a6294162a3bb740d0a21457fd6ef5c4d5092d75b4ca"
  },
  {
    path: "prisma/migrations/20260920120000_psr_p2_raw_identity_prerequisite/migration.sql",
    gitBlob: "4b8d3fb9f6af6af1d8fdb052c43936a41ea5d3ca",
    sha256: "0d436eed57ba2e6aa6f313f3a121fc33ed3a6c884339ce8ce441db1b5301bf62"
  },
  {
    path: "prisma/migrations/20260920180000_psr_p2_production_quantity_edit_identity/migration.sql",
    gitBlob: "6f43c79b1efa3a452d2ed46aa6a8a55edc6a51ed",
    sha256: "997fcb0caf5f57f3514aa981976c72122f0c09e35a408922f1baea5df1a51a61"
  },
  {
    path: "prisma/migrations/20261008120000_upakovka_recovery_receipt/migration.sql",
    gitBlob: "06fad978a25fea9b584bed8558401bb8e54d2b98",
    sha256: "7a243476d0dc561dde1e31d11db16613996a3d5e0a88af7695a6b48950cc3c54"
  },
  {
    path: "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
    gitBlob: "3e54eaaae450f76edf75163024bebf4d7d70c358",
    sha256: "47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5"
  },
  {
    path: "prisma/migrations/migration_lock.toml",
    gitBlob: "044d57cdb0d5b5bff3475112359a4ee70439bf78",
    sha256: "99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900"
  }
];

// src/server/internal/p1-isolated-runner/schema-contract.ts
var P1_SCHEMA_PROBE_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  a.attname AS column_name,
  t.typname AS udt_name,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
  pg_get_expr(ad.adbin, ad.adrelid) AS column_default
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND a.attname = 'receiptProvenanceSnapshot'
  AND a.attnum > 0
  AND NOT a.attisdropped;

SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid, true) AS definition,
  con.convalidated AS validated
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
  AND con.contype = 'c';

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  l.lanname AS language,
  p.prosecdef AS security_definer,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.proname = 'batch_creation_command_provenance_guard';

SELECT
  tn.nspname AS schema_name,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  t.tgenabled::text AS enabled,
  pg_get_triggerdef(t.oid, true) AS definition,
  fn.nspname AS function_schema,
  fp.proname AS function_name,
  pg_get_function_identity_arguments(fp.oid) AS function_identity_arguments
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace tn ON tn.oid = c.relnamespace
JOIN pg_proc fp ON fp.oid = t.tgfoid
JOIN pg_namespace fn ON fn.oid = fp.pronamespace
WHERE tn.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND NOT t.tgisinternal
  AND t.tgname = 'batch_creation_command_provenance_guard';
`.trim();
var P1_IDENTITY_PROBE_SQL = `
SELECT
  current_database() AS current_database,
  current_setting('server_version_num')::int AS server_version_num,
  run_id,
  nonce,
  container_id
FROM public.stell22_p1_disposable_identity
WHERE singleton = true
`.trim();
var P1_HISTORY_PROBE_SQL = `
SELECT
  migration_name,
  checksum,
  started_at,
  finished_at,
  rolled_back_at,
  applied_steps_count
FROM public."_prisma_migrations"
`.trim();
var P1_FUNCTION_BODY = normalizeSql(
  `
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
`.trim()
);
function normalizeSql(sql) {
  return stripComments(sql).replace(/\s+/g, " ").trim();
}
function stripComments(sql) {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (pair === "/*") {
      index += 2;
      while (index < sql.length && sql.slice(index, index + 2) !== "*/") index += 1;
      index += 2;
      continue;
    }
    if (sql[index] === "'") {
      out += sql[index];
      index += 1;
      while (index < sql.length) {
        out += sql[index];
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            out += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

// src/server/internal/p1-isolated-runner/classify.ts
var SQL_FILES = PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql"));
function migrationNameFromPath(path) {
  const name = path.split("/")[2];
  if (!name) {
    throw new Error(`Unpinned migration path ${path}`);
  }
  return name;
}
var CHECKSUM_BY_NAME = new Map(
  SQL_FILES.map((entry) => [migrationNameFromPath(entry.path), entry.sha256])
);
var HISTORICAL_MIGRATION_NAMES = SQL_FILES.map(
  (entry) => migrationNameFromPath(entry.path)
).filter((name) => name !== P1_MIGRATION_NAME);
if (HISTORICAL_MIGRATION_NAMES.length !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
  throw new Error("Historical migration pin does not contain 45 names");
}

// src/server/internal/p1-isolated-runner/p1-release-gate.ts
var PRODUCTION_NAMES = new Set(FORBIDDEN_CONTAINER_IDENTIFIERS);

// src/server/internal/p1-production-adapter/contract.ts
var PROPOSED_MIGRATOR_ROLE = "stell22_migrator";

// src/server/internal/p1-role-split-disposable/topology.ts
var DISPOSABLE_APP_ROLE = "stell22_app";
var MIGRATOR_ROLE = PROPOSED_MIGRATOR_ROLE;

// src/server/internal/p1-legacy-role-transition/plan.ts
var LEGACY_ADMIN_ROLE = "stell22";
var LEGACY_SCHEMA_OWNER = "pg_database_owner";
var DISPOSABLE_DATABASE = /^p1as_[0-9a-f]{8}$/;
var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
var ROUTINE_ARGUMENTS = /^[A-Za-z0-9_[\], ]*$/;
var PASSWORD = /^[0-9a-f]{32}$/;
var PRODUCTION_PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;
var RELATION_KIND = {
  r: "table",
  p: "table",
  S: "sequence",
  v: "view",
  m: "view"
};
var HISTORICAL_CHECKSUMS = new Map(
  PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql") && !entry.path.includes(P1_MIGRATION_NAME)).map((entry) => {
    const name = entry.path.split("/")[2];
    if (!name) throw new Error("pinned historical migration path has no name");
    return [name, entry.sha256];
  })
);
if (HISTORICAL_CHECKSUMS.size !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
  throw new Error("pinned historical migration count is not 45");
}
function planLegacyTransition(input) {
  const policy = input.databasePolicy ?? "disposable";
  const database = input.catalog.databaseName;
  if (policy === "production-candidate") {
    if (database !== LEGACY_ADMIN_ROLE) return refuse("PRODUCTION_DATABASE");
  } else {
    if (FORBIDDEN_DATABASE_NAMES.some((name) => name === database.toLowerCase())) {
      return refuse("PRODUCTION_DATABASE");
    }
    if (!DISPOSABLE_DATABASE.test(database)) return refuse("DISPOSABLE_DATABASE_REFUSED");
  }
  if (!passwordAccepted(policy, input.appPassword) || !passwordAccepted(policy, input.migratorPassword) || input.appPassword === input.migratorPassword) {
    return refuse("CREDENTIAL_REFUSED");
  }
  if (input.catalog.schemaOwner !== LEGACY_SCHEMA_OWNER) return refuse("UNEXPECTED_SCHEMA_OWNER");
  if (!input.catalog.adminSuperuser || !input.catalog.adminLogin) return refuse("LEGACY_ADMIN_REFUSED");
  if (input.catalog.appRoleExists || input.catalog.migratorRoleExists) return refuse("LEGACY_ROLE_PRESENT");
  const batch = input.catalog.relations.find((relation) => relation.name === "BatchCreationCommand" && relation.kind === "r");
  const migrations = input.catalog.relations.find((relation) => relation.name === "_prisma_migrations" && relation.kind === "r");
  if (!batch || !migrations) return refuse("REQUIRED_OBJECT_MISSING");
  const inventory = [];
  const relations = [...input.catalog.relations].sort((left, right) => compareText(relationSort(left), relationSort(right)) || compareText(left.name, right.name));
  for (const relation of relations) {
    if (relation.owner !== LEGACY_ADMIN_ROLE) return refuse("LEGACY_OWNERSHIP_DIFFERS");
    const kind = RELATION_KIND[relation.kind];
    if (!kind || !IDENTIFIER.test(relation.name)) return refuse("UNSAFE_IDENTIFIER");
    const quoted = quoteIdent(relation.name);
    const verb = kind === "sequence" ? "SEQUENCE" : kind === "view" ? "VIEW" : "TABLE";
    inventory.push({
      key: `${kind}:${relation.name}`,
      statement: `ALTER ${verb} public.${quoted} OWNER TO ${MIGRATOR_ROLE}`
    });
  }
  const routines = [...input.catalog.routines].sort((left, right) => compareText(left.name, right.name) || compareText(left.identityArguments, right.identityArguments));
  for (const routine of routines) {
    if (routine.owner !== LEGACY_ADMIN_ROLE) return refuse("LEGACY_OWNERSHIP_DIFFERS");
    if (!IDENTIFIER.test(routine.name) || !ROUTINE_ARGUMENTS.test(routine.identityArguments)) return refuse("UNSAFE_IDENTIFIER");
    inventory.push({
      key: `routine:${routine.name}:${routine.identityArguments}`,
      statement: `ALTER FUNCTION public.${quoteIdent(routine.name)}(${routine.identityArguments}) OWNER TO ${MIGRATOR_ROLE}`
    });
  }
  const history = checkHistory(input.catalog.history);
  if (!history.ok) return history;
  if (input.p1Checksum !== P1_SHA256) return refuse("P1_CHECKSUM_DIFFERS");
  const statements = [
    "BEGIN",
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
    `CREATE ROLE ${DISPOSABLE_APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.appPassword}'`,
    `CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.migratorPassword}'`,
    `GRANT CONNECT ON DATABASE ${database} TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT CONNECT ON DATABASE ${database} TO ${MIGRATOR_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR_ROLE}`,
    ...inventory.map((item) => item.statement),
    ...grantStatements(relations),
    ...routines.map((routine) => `GRANT EXECUTE ON FUNCTION public.${quoteIdent(routine.name)}(${routine.identityArguments}) TO ${DISPOSABLE_APP_ROLE}`),
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM ${DISPOSABLE_APP_ROLE}`,
    `GRANT SELECT ON TABLE public."_prisma_migrations" TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${DISPOSABLE_APP_ROLE}`,
    "COMMIT"
  ];
  return { ok: true, inventory, sql: statements.map((statement) => `${statement};`).join("\n") };
}
function checkHistory(history) {
  if (history.length !== HISTORICAL_CHECKSUMS.size) return refuse("MIGRATION_HISTORY_DIFFERS");
  const seen = /* @__PURE__ */ new Set();
  for (const row of history) {
    if (seen.has(row.migrationName)) return refuse("MIGRATION_HISTORY_DIFFERS");
    seen.add(row.migrationName);
    if (HISTORICAL_CHECKSUMS.get(row.migrationName) !== row.checksum) return refuse("MIGRATION_HISTORY_DIFFERS");
    if (row.finishedAt === null || row.finishedAt.length === 0 || row.rolledBackAt !== null || row.appliedStepsCount !== 1) {
      return refuse("MIGRATION_HISTORY_DIFFERS");
    }
  }
  return { ok: true };
}
function grantStatements(relations) {
  const statements = [];
  for (const relation of relations) {
    const kind = RELATION_KIND[relation.kind];
    const quoted = `public.${quoteIdent(relation.name)}`;
    if (relation.name === "_prisma_migrations") continue;
    if (kind === "table") statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
    if (kind === "view") statements.push(`GRANT SELECT ON TABLE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
    if (kind === "sequence") statements.push(`GRANT USAGE, SELECT ON SEQUENCE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
  }
  return statements;
}
function relationSort(relation) {
  const kind = RELATION_KIND[relation.kind];
  if (kind === "table") return "1";
  if (kind === "sequence") return "2";
  return "3";
}
function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
function passwordAccepted(policy, value) {
  return policy === "production-candidate" ? PRODUCTION_PASSWORD.test(value) : PASSWORD.test(value);
}
function refuse(code) {
  return { ok: false, code };
}

// src/server/internal/p1-production-release/plan-entry.ts
var catalogPath = process.argv[2];
if (!catalogPath) {
  process.stdout.write("RESULT=STOP_LOCKED\n");
  process.exit(1);
}
var plan = planLegacyTransition({
  catalog: readCatalog((0, import_node_fs.readFileSync)(catalogPath, "utf8")),
  appPassword: process.env.APP_DB_PASSWORD ?? "",
  migratorPassword: process.env.MIGRATOR_DB_PASSWORD ?? "",
  p1Checksum: P1_SHA256,
  databasePolicy: "production-candidate"
});
if (!plan.ok) {
  process.stdout.write(`RESULT=${plan.code}
`);
  process.exit(1);
}
process.stdout.write(plan.sql);
function readCatalog(text) {
  let databaseName = "";
  let schemaOwner = "";
  let adminSuperuser = false;
  let adminLogin = false;
  let appRoleExists = false;
  let migratorRoleExists = false;
  const relations = [];
  const routines = [];
  const history = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [kind, payload = ""] = splitOnce(line);
    if (kind === "database") databaseName = payload;
    if (kind === "schemaOwner") schemaOwner = payload;
    if (kind === "admin") {
      const [superuser, login] = payload.split("|");
      adminSuperuser = superuser === "true";
      adminLogin = login === "true";
    }
    if (kind === "roles") {
      const [app, migrator] = payload.split("|");
      appRoleExists = app === "true";
      migratorRoleExists = migrator === "true";
    }
    if (kind === "relation") {
      const [name, relationKind, owner] = payload.split("|");
      if (!name || !relationKind || !owner) throw new Error("relation catalog row is incomplete");
      relations.push({ name, kind: relationKind, owner });
    }
    if (kind === "routine") {
      const [name, identityArguments, owner] = payload.split("|");
      if (!name || identityArguments === void 0 || !owner) throw new Error("routine catalog row is incomplete");
      routines.push({ name, identityArguments, owner });
    }
    if (kind === "history") {
      const [migrationName, checksum, finishedAt, rolledBackAt, appliedSteps] = payload.split("|");
      if (!migrationName || !checksum || appliedSteps === void 0) throw new Error("history catalog row is incomplete");
      history.push({
        migrationName,
        checksum,
        finishedAt: finishedAt && finishedAt.length > 0 ? finishedAt : null,
        rolledBackAt: rolledBackAt && rolledBackAt.length > 0 ? rolledBackAt : null,
        appliedStepsCount: Number(appliedSteps)
      });
    }
  }
  return { databaseName, schemaOwner, adminSuperuser, adminLogin, appRoleExists, migratorRoleExists, relations, routines, history };
}
function splitOnce(line) {
  const index = line.indexOf(" ");
  if (index === -1) return [line, ""];
  return [line.slice(0, index), line.slice(index + 1)];
}
