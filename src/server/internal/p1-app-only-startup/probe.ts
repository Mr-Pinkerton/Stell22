/**
 * Read-only startup catalog.
 * Every statement is a SELECT. None of them creates or updates a migration row.
 */

export const STARTUP_ROLE_SQL = `
SELECT json_build_object(
  'currentUser', current_user,
  'sessionUser', session_user,
  'databaseName', current_database(),
  'rolsuper', r.rolsuper,
  'rolcreatedb', r.rolcreatedb,
  'rolcreaterole', r.rolcreaterole,
  'rolreplication', r.rolreplication,
  'rolbypassrls', r.rolbypassrls,
  'rolcanlogin', r.rolcanlogin,
  'memberships', COALESCE((
    SELECT json_agg(member_role.rolname ORDER BY member_role.rolname)
    FROM pg_auth_members m
    JOIN pg_roles member_role ON member_role.oid = m.roleid
    WHERE m.member = r.oid
  ), '[]'::json),
  'schemaUsage', has_schema_privilege(current_user, 'public', 'USAGE'),
  'schemaCreate', has_schema_privilege(current_user, 'public', 'CREATE'),
  'ownedTableCount', (
    SELECT count(*)::int
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid
  ),
  'historyTable', to_regclass('public._prisma_migrations') IS NOT NULL
) AS report
FROM pg_roles r
WHERE r.rolname = current_user
`.trim();

export const STARTUP_HISTORY_SQL = `
SELECT COALESCE(json_agg(json_build_object(
  'migrationName', migration_name,
  'checksum', checksum,
  'startedAt', started_at,
  'finishedAt', finished_at,
  'rolledBackAt', rolled_back_at,
  'appliedStepsCount', applied_steps_count
) ORDER BY migration_name), '[]'::json) AS report
FROM public."_prisma_migrations"
`.trim();

export const STARTUP_SCHEMA_SQL = `
SELECT json_build_object(
  'column', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'table_name', c.relname,
      'udt_name', t.typname,
      'data_type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'is_nullable', CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
      'column_default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
    ))
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND a.attname = 'receiptProvenanceSnapshot'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), '[]'::json),
  'check', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'table_name', c.relname,
      'constraint_name', con.conname,
      'definition', pg_catalog.pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated
    ))
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
      AND con.contype = 'c'
  ), '[]'::json),
  'function', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'function_name', p.proname,
      'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'language', l.lanname,
      'security_definer', p.prosecdef,
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    ))
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND p.proname = 'batch_creation_command_provenance_guard'
  ), '[]'::json),
  'trigger', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', tn.nspname,
      'table_name', c.relname,
      'trigger_name', t.tgname,
      'enabled', t.tgenabled::text,
      'definition', pg_catalog.pg_get_triggerdef(t.oid, true),
      'function_schema', fn.nspname,
      'function_name', fp.proname,
      'function_identity_arguments', pg_catalog.pg_get_function_identity_arguments(fp.oid)
    ))
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = c.relnamespace
    JOIN pg_catalog.pg_proc fp ON fp.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
    WHERE tn.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname = 'batch_creation_command_provenance_guard'
      AND startup_search_path.configured = 'pg_catalog'
  ), '[]'::json),
  'extraTriggers', COALESCE((
    SELECT json_agg(t.tgname)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname <> 'batch_creation_command_provenance_guard'
  ), '[]'::json),
  'unexpectedObjects', COALESCE((
    SELECT json_agg(n.nspname || '.' || p.proname)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname <> 'batch_creation_command_provenance_guard'
      AND (p.proname LIKE '%provenance%' OR p.proname LIKE '%receipt%')
  ), '[]'::json),
  'foreignKeyCount', (
    SELECT count(*)::int
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.contype = 'f'
  )
) AS report
FROM (SELECT set_config('search_path', 'pg_catalog', true) AS configured) AS startup_search_path
`.trim();
