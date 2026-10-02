#!/usr/bin/env python3
"""Exercise migration 029 and the real caller on disposable LOCAL PostgreSQL 16.

Requires psycopg 3 and an explicit LOCALTESTDSN, for example:
  LOCALTESTDSN='host=/tmp/local-pg port=55439 dbname=postgres user=test_admin' \
    python3 scripts/test-platform-keyword-rls.py

Only the postgres maintenance database may be supplied. The script creates and
finally drops its own UUID-named database and roles, never a supplied database.
Pre-existing knowledge_app_reader is checked, reused and never altered/dropped.
The local server must provide its bundled pg_trgm and auto_explain modules.
No production URL, credentials, document text, or arbitrary SQL is accepted.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
BASELINE = "4ba8bb7"
WORKER = "knowledge_app_reader"
FUNCTION = "public.search_platform_keyword_candidates(text,text,text,text,text,text,integer)"
MIGRATION = ROOT / "migrations/029-platform-keyword-candidates.sql"
GUCS = ("app.account_id", "app.current_account_id", "app.user_id",
        "app.current_user_id", "app.current_user_identity")
RESULT: dict = {"status": "running", "checks": [], "baseline_commit": BASELINE}
STAGE = "local connection guard"


class CheckFailure(Exception):
    """A diagnostic with no connection strings or external exception text."""


def check(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def passed(name: str) -> None:
    RESULT["checks"].append(name)


def local_parameters() -> dict:
    raw = os.environ.get("LOCALTESTDSN")
    check(bool(raw), "LOCALTESTDSN must be explicitly supplied")
    parameters = conninfo_to_dict(raw)
    check(set(parameters) <= {"host", "port", "dbname", "user", "password", "connect_timeout"},
          "Only explicit local host/port/database/user connection parameters are accepted")
    check(not any(os.environ.get(key) for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS")),
          "Ambiguous libpq host/service/options environment is not accepted")
    check(parameters.get("dbname") == "postgres", "Only postgres maintenance database is accepted")
    check(parameters.get("port") == "55439", "Only the dedicated local test port 55439 is accepted")
    check(bool(parameters.get("user")), "An explicit local admin role is required")
    host = parameters.get("host", "")
    local_socket = host.startswith("/") and Path(host).resolve().is_relative_to(Path("/tmp").resolve())
    check(local_socket or host in ("127.0.0.1", "::1"), "Nonlocal hosts and non-temporary sockets are refused")
    parameters["connect_timeout"] = 5
    return parameters


def connect(parameters: dict):
    return psycopg.connect(**parameters, autocommit=True, row_factory=dict_row, prepare_threshold=None)


def role(connection, name: str) -> None:
    connection.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(name)))


def extracted_query(source: str) -> str:
    body = source[source.index("async function keywordSearch("):]
    start = body.index("(sql) => sql`") + len("(sql) => sql`")
    query = body[start:body.index("  `, pool, trace);")]
    query = query.replace("${sql.unsafe(knowledgeChunkTable)}", "public.knowledge_chunk")
    query = query.replace("${sql.unsafe(`${getKnowledgeSchema(env)}.search_platform_keyword_candidates`)}",
                          "public.search_platform_keyword_candidates")
    query = query.replace("%", "%%")
    query = re.sub(r"\$\{(\w+)\}", lambda match: "%(" + match[1] + ")s", query)
    check("${" not in query, "Caller SQL template changed; update the explicit extractor")
    return query


def parameters(query: str, source=None, kind=None, limit=20) -> dict:
    entity = re.search(r"[A-Z]{2,}\.\w+\.\d+", query)
    code = entity[0] if entity else None
    rest = query.replace(code, "", 1).replace("§", "").replace("#", "").strip() if code else None
    return dict(pattern="%" + query + "%", ftsQuery=query.replace("-", " "),
                entityPattern="%" + code + "%" if code else None,
                sectionPattern="%" + rest + "%" if rest else None,
                src=source, stype=kind, limit=limit, SEARCH_RESPONSE_EXCERPT_CHARACTERS=2000,
                SEARCH_RESPONSE_TRUNCATION_MARKER="\n\n...[truncated; use get_document for the full document]")


def expect_sqlstate(connection, statement, expected: str, values=None) -> None:
    try:
        connection.execute(statement, values)
    except psycopg.Error as error:
        connection.rollback()
        check(error.sqlstate == expected, "Unexpected SQLSTATE in a negative regression")
    else:
        raise CheckFailure("Negative regression unexpectedly succeeded")


def apply_migration(connection, migration: str) -> None:
    connection.execute(migration, prepare=False)


def ensure_function_absent(connection) -> None:
    row = connection.execute("SELECT to_regprocedure(%s) AS function", (FUNCTION,)).fetchone()
    check(row["function"] is None, "Failed migration leaked a function outside rollback")


def make_fixture(connection, owner: str, outsider: str, nonbypass: str) -> None:
    connection.execute("CREATE EXTENSION pg_trgm")
    connection.execute(sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}, {}")
                       .format(sql.Identifier(owner), sql.Identifier(nonbypass)))
    connection.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}, {}")
                       .format(sql.Identifier(WORKER), sql.Identifier(outsider)))
    role(connection, owner)
    connection.execute("""CREATE TABLE public.knowledge_chunk (
      legacy_id bigint PRIMARY KEY, source_uri text, content text, source text,
      source_kind text, account_id text, search_vector tsvector
    )""")
    connection.execute("""INSERT INTO public.knowledge_chunk
      SELECT n, 'background/'||n||'.md', repeat('synthetic background '||n||' ',32),
        'background','ds',CASE WHEN n%10=0 THEN NULL ELSE 'background-owner' END,
        to_tsvector('simple','background') FROM generate_series(100,4099) n""")
    canaries = [
        (1, "DP.TEST.007.md", "a" * 110, "alpha", "pack", None, "background"),
        (2, "DP.TEST.007-section.md", "section 4a " + "b" * 220, "alpha", "pack", None, "background"),
        (3, "body.md", "DP.TEST.007 " + "c" * 330, "beta", "ds", None, "DP.TEST.007"),
        (4, "stored-fts.md", "No matching terms here " + "d" * 440, "alpha", "pack", None, "spectral canary"),
        (5, "wrong-fts.md", "Body contains spectral canary " + "e" * 550, "beta", "ds", None, "unrelated stored vector"),
        (6, "wildZZcard.md", "f" * 660, "alpha", "pack", None, "background"),
        (7, "underXscore.md", "g" * 770, "alpha", "pack", None, "background"),
        (8, None, "nullable token " + "h" * 880, None, None, None, "nullable token"),
        (9, "null-content.md", None, "alpha", None, None, "nullable token"),
        (10, "empty-vector.md", "nullable token " + "i" * 990, "beta", "ds", None, None),
        (11, "long-body.md", "longexact " + "j" * 3200, "alpha", "pack", None, "background"),
        (12, "hyphen.md", "needle gap " + "k" * 1210, "alpha", "pack", None, "needle gap"),
        (13, "DP.TEST.007-private.md", "PRIVATE_CANARY spectral canary", "alpha", "pack", "private-owner", "spectral canary DP.TEST.007"),
        (14, "private-only.md", "PRIVATE_CANARY", "private-source", "private-type", "other-owner", "PRIVATE_CANARY"),
        (15, "longer-body.md", "longexact " + "m" * 4100, "alpha", "pack", None, "background"),
    ]
    with connection.cursor() as cursor:
        cursor.executemany("""INSERT INTO public.knowledge_chunk VALUES
          (%s,%s,%s,%s,%s,%s,CASE WHEN %s::text IS NULL THEN NULL ELSE to_tsvector('simple',%s) END)""",
                           [(*row[:6], row[6], row[6]) for row in canaries])
    connection.execute("ALTER TABLE public.knowledge_chunk ENABLE ROW LEVEL SECURITY")
    connection.execute("ALTER TABLE public.knowledge_chunk FORCE ROW LEVEL SECURITY")
    connection.execute("""CREATE POLICY keyword_read ON public.knowledge_chunk FOR SELECT USING (
      account_id IS NULL OR account_id = NULLIF(current_setting('app.account_id',true),'')
    )""")
    connection.execute(sql.SQL("GRANT SELECT ON public.knowledge_chunk TO {}, {}")
                       .format(sql.Identifier(WORKER), sql.Identifier(nonbypass)))
    for name, column in (("fixture_platform_path", "source_uri gin_trgm_ops"),
                         ("fixture_platform_content", "content gin_trgm_ops"),
                         ("fixture_platform_fts", "search_vector")):
        connection.execute(sql.SQL("CREATE INDEX {} ON public.knowledge_chunk USING gin ({}) WHERE account_id IS NULL")
                           .format(sql.Identifier(name), sql.SQL(column)))
    connection.execute("ANALYZE public.knowledge_chunk")  # Disposable fixture only, never migration/production.


def privilege_snapshot(connection) -> dict:
    return connection.execute("""SELECT
      has_table_privilege(%s,'public.knowledge_chunk','SELECT') AS select_allowed,
      has_table_privilege(%s,'public.knowledge_chunk','INSERT') AS insert_allowed,
      has_table_privilege(%s,'public.knowledge_chunk','UPDATE') AS update_allowed,
      has_table_privilege(%s,'public.knowledge_chunk','DELETE') AS delete_allowed,
      has_table_privilege(%s,'public.knowledge_chunk','TRUNCATE') AS truncate_allowed
    """, (WORKER,) * 5).fetchone()


def migration_guards(connection, migration: str, owner: str, outsider: str, nonbypass: str) -> None:
    role(connection, nonbypass)
    expect_sqlstate(connection, migration, "P0001")
    ensure_function_absent(connection)
    passed("non-BYPASS migration owner rejected and rolled back")
    role(connection, owner)
    for scope in ("", "IN SCHEMA public"):
        connection.execute(sql.SQL("ALTER DEFAULT PRIVILEGES {} GRANT EXECUTE ON FUNCTIONS TO {}")
                           .format(sql.SQL(scope), sql.Identifier(outsider)))
        try:
            expect_sqlstate(connection, migration, "P0001")
            ensure_function_absent(connection)
        finally:
            connection.execute(sql.SQL("ALTER DEFAULT PRIVILEGES {} REVOKE EXECUTE ON FUNCTIONS FROM {}")
                               .format(sql.SQL(scope), sql.Identifier(outsider)))
    passed("unexpected global and schema default ACLs rejected atomically")
    apply_migration(connection, migration)
    passed("actual migration installed successfully under BYPASSRLS owner")


def equivalence_and_attacks(connection, old: str, new: str, owner: str, outsider: str) -> None:
    before = privilege_snapshot(connection)
    check(before == dict(select_allowed=True, insert_allowed=False, update_allowed=False,
                         delete_allowed=False, truncate_allowed=False), "Unexpected worker table privileges")
    role(connection, WORKER)
    cases = [parameters("DP.TEST.007"), parameters("DP.TEST.007", "alpha"),
             parameters("DP.TEST.007", None, "ds"), parameters("DP.TEST.007 §4a"),
             parameters("DP.TEST.007 §absent"), parameters("spectral canary"),
             parameters("needle-gap"), parameters("nullable token"), parameters("longexact"),
             parameters("wild%card"), parameters("under_score"),
             parameters("' OR true; DROP TABLE knowledge_chunk; --"),
             parameters("DP.TEST.007", "alpha' OR true --"),
             parameters("does-not-exist"), parameters("DP.TEST.007", limit=1),
             parameters("longexact", limit=1), parameters("longexact", limit=2)]
    for case in cases:
        expected = connection.execute(old, case).fetchall()
        actual = connection.execute(new, case).fetchall()
        check(expected == actual, "Original/candidate SQL differs in values, ordering, or scores")
        check(not any(row["id"] in (13, 14) for row in actual), "Private candidate escaped public SQL")
    fts_rows = connection.execute(new, parameters("spectral canary")).fetchall()
    check(any(row["id"] == 4 and str(row["score"]) == "0.8" for row in fts_rows),
          "Stored FTS canary vanished or lost its original score")
    long_rows = connection.execute(new, parameters("longexact", limit=2)).fetchall()
    check([row["id"] for row in long_rows] == [15, 11], "Full-content length order changed after excerpting")
    marker = parameters("")["SEARCH_RESPONSE_TRUNCATION_MARKER"]
    check(all(len(row["content"]) == 2000 + len(marker) and row["content"].endswith(marker)
              for row in long_rows), "Excerpt size or truncation marker drifted")
    passed(f"{len(cases)} exact old/new output/order/score comparisons including stored FTS and nulls")
    for requested, expected in ((None, 5), (-10, 1), (0, 1), (1, 1), (20, 20), (1000000, 20)):
        bounded = connection.execute("""SELECT * FROM public.search_platform_keyword_candidates(
            '%%',NULL,NULL,'',NULL,NULL,%s)""", (requested,)).fetchall()
        check(len(bounded) == expected, "Function did not apply bounded global result count")
        check(all(row["content"] is None or len(row["content"]) <= 2000 + len(marker) for row in bounded),
              "Function materialized an unbounded output document")
    passed("bounded global LIMIT and excerpts preserve ordering by original full content length")
    for guc in GUCS:
        connection.execute("SELECT set_config(%s,'private-owner',false)", (guc,))
    visible = connection.execute("SELECT legacy_id FROM public.knowledge_chunk WHERE legacy_id=13").fetchall()
    check(len(visible) == 1, "Spoof canary did not exercise permissive account context")
    candidates = connection.execute("SELECT * FROM public.search_platform_keyword_candidates('%PRIVATE_CANARY%',NULL,NULL,'PRIVATE_CANARY',NULL,NULL,20)").fetchall()
    check(candidates == [], "Spoofed GUC exposed private candidates")
    for guc in GUCS:
        connection.execute("SELECT set_config(%s,'',false)", (guc,))
    passed("spoofed account GUCs cannot widen fixed public-only candidates")
    connection.execute("CREATE TEMP TABLE knowledge_chunk(legacy_id bigint, source_uri text, content text, source text, source_kind text, search_vector tsvector)")
    connection.execute("INSERT INTO pg_temp.knowledge_chunk VALUES(-1,'shadow','PRIVATE_CANARY','alpha','pack',NULL)")
    connection.execute("SET search_path=pg_temp,public,pg_catalog")
    shadow = connection.execute("SELECT * FROM public.search_platform_keyword_candidates('%PRIVATE_CANARY%',NULL,NULL,'PRIVATE_CANARY',NULL,NULL,20)").fetchall()
    check(shadow == [], "Temporary table shadow entered SECURITY DEFINER lookup")
    connection.execute("RESET search_path")
    passed("temporary relation shadow cannot replace qualified public table")
    for statement in ("INSERT INTO public.knowledge_chunk(legacy_id) VALUES(-99)",
                      "UPDATE public.knowledge_chunk SET source='bad' WHERE legacy_id=1",
                      "DELETE FROM public.knowledge_chunk WHERE legacy_id=1",
                      "TRUNCATE public.knowledge_chunk"):
        expect_sqlstate(connection, statement, "42501")
    role(connection, owner)
    check(privilege_snapshot(connection) == before, "Migration changed table write permissions")
    passed("INSERT UPDATE DELETE TRUNCATE remain denied")
    role(connection, outsider)
    expect_sqlstate(connection, "SELECT * FROM public.search_platform_keyword_candidates('%',NULL,NULL,'',NULL,NULL,20)", "42501")
    role(connection, owner)
    passed("unauthorized role cannot execute candidate function")


def plan_nodes(node):
    yield node
    for child in node.get("Plans", []):
        yield from plan_nodes(child)


def actual_plan_checks(connection, old: str, new: str, owner: str) -> None:
    connection.execute("RESET ROLE")
    connection.execute("LOAD 'auto_explain'")
    connection.execute("SET auto_explain.log_min_duration=0")
    connection.execute("SET auto_explain.log_analyze=on")
    connection.execute("SET auto_explain.log_buffers=on")
    connection.execute("SET auto_explain.log_nested_statements=on")
    connection.execute("SET auto_explain.log_format=json")
    connection.execute("SET auto_explain.log_level=notice")
    nested_plans = []

    def capture_notice(diagnostic):
        message = diagnostic.message_primary or ""
        if "plan:" in message and "{" in message:
            plan = json.loads(message[message.index("{"):])
            if "FROM public.knowledge_chunk AS c" in plan.get("Query Text", ""):
                nested_plans.append(plan)

    connection.add_notice_handler(capture_notice)
    role(connection, WORKER)
    timings = []
    # SQL functions use a parameter-independent internal plan, not the prepared
    # statement five-custom-plans threshold. Capture their actual nested plans.
    runtime_cases = [parameters("DP.TEST.007"), parameters("DP.TEST.007", "alpha"),
                     parameters("spectral canary"), parameters("nullable token")]
    for index in range(12):
        case = runtime_cases[index % len(runtime_cases)]
        started = time.perf_counter()
        connection.execute(new, case).fetchall()
        timings.append(round((time.perf_counter() - started) * 1000, 3))
    old_plan = connection.execute("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + old, parameters("DP.TEST.007")).fetchone()["QUERY PLAN"][0]
    new_plan = connection.execute("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + new, parameters("DP.TEST.007")).fetchone()["QUERY PLAN"][0]
    old_nodes = list(plan_nodes(old_plan["Plan"]))
    check(not any("Index Cond" in node and any(operator in node["Index Cond"] for operator in ("~~", "@@"))
                  for node in old_nodes), "Fixture no longer reproduces RLS keyword predicate barrier")
    check(any(node["Node Type"] == "Function Scan" for node in plan_nodes(new_plan["Plan"])), "Actual caller bypassed candidate function")
    connection.execute("RESET ROLE")
    connection.execute("SET auto_explain.log_min_duration=-1")
    connection.remove_notice_handler(capture_notice)
    check(len(nested_plans) >= 12, "Actual nested function plans were not captured")
    RESULT["runtime_plans"] = {"old_worker": old_plan, "new_worker": new_plan,
                               "same_connection_12_calls_ms": timings,
                               "actual_nested_plans": nested_plans,
                               "nested_keyword_index_path": any(
                                   "Index Cond" in node and any(operator in node["Index Cond"] for operator in ("~~", "@@"))
                                   for plan in nested_plans for node in plan_nodes(plan["Plan"]))}
    check(RESULT["runtime_plans"]["nested_keyword_index_path"], "Actual cached function did not expose indexed keyword predicates")
    passed("FORCE RLS blocks old keyword index conditions; actual nested function uses indexed predicates")
    role(connection, owner)


def run() -> None:
    global STAGE
    parameters_local = local_parameters()
    old_source = subprocess.run(["git", "show", f"{BASELINE}:src/index.ts"], cwd=ROOT,
                                check=True, capture_output=True, text=True).stdout
    old = extracted_query(old_source)
    new = extracted_query((ROOT / "src/index.ts").read_text())
    migration = MIGRATION.read_text()
    RESULT["migration_sha256"] = hashlib.sha256(migration.encode()).hexdigest()
    token = uuid.uuid4().hex
    database = "mim_keyword_rls_test_" + token
    owner, outsider, nonbypass = ("mim_rls_" + kind + "_" + token for kind in ("owner", "outsider", "limited"))
    created_roles = []
    created_database = False
    database_connection = None
    with connect(parameters_local) as admin:
        check(admin.execute("SELECT rolsuper FROM pg_roles WHERE rolname=current_user").fetchone()["rolsuper"],
              "An isolated local superuser is required to create test roles")
        check(160000 <= int(admin.execute("SHOW server_version_num").fetchone()["server_version_num"]) < 170000,
              "This harness targets PostgreSQL 16")
        try:
            STAGE = "create disposable local fixture"
            for name, bypass in ((owner, True), (outsider, False), (nonbypass, False), (WORKER, False)):
                existing = admin.execute("SELECT rolbypassrls,rolsuper,rolcanlogin FROM pg_roles WHERE rolname=%s", (name,)).fetchone()
                if existing:
                    check(name == WORKER and not any(existing.values()), "Existing worker role must be NOLOGIN/NOBYPASSRLS/NOSUPERUSER")
                else:
                    admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER {} NOCREATEDB NOCREATEROLE")
                                  .format(sql.Identifier(name), sql.SQL("BYPASSRLS" if bypass else "NOBYPASSRLS")))
                    created_roles.append(name)
            admin.execute(sql.SQL("CREATE DATABASE {} OWNER {} TEMPLATE template0")
                          .format(sql.Identifier(database), sql.Identifier(owner)))
            created_database = True
            database_connection = connect(parameters_local | {"dbname": database})
            connection = database_connection
            connection.execute("SET statement_timeout='10s'")
            make_fixture(connection, owner, outsider, nonbypass)
            prior_table_privileges = privilege_snapshot(connection)
            STAGE = "migration authorization and rollback guards"
            migration_guards(connection, migration, owner, outsider, nonbypass)
            check(privilege_snapshot(connection) == prior_table_privileges, "Migration changed worker table ACLs")
            STAGE = "query equivalence and access attacks"
            equivalence_and_attacks(connection, old, new, owner, outsider)
            STAGE = "actual runtime plan and cached function calls"
            actual_plan_checks(connection, old, new, owner)
            RESULT["status"] = "passed"
        finally:
            if database_connection is not None:
                database_connection.close()
            if created_database:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))
            for name in reversed(created_roles):
                admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))
            RESULT["cleanup"] = "own temporary database and newly created roles removed; pre-existing roles preserved"


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        RESULT.update(status="failed", stage=STAGE, error_type=type(error).__name__)
        if isinstance(error, CheckFailure):
            RESULT["message"] = str(error)
        if isinstance(error, psycopg.Error):
            RESULT["sqlstate"] = error.sqlstate
        print(json.dumps(RESULT, indent=2, default=str))
        sys.exit(1)
    print(json.dumps(RESULT, indent=2, default=str))
