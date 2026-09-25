"""Concurrent cleanup test. Requires an empty, disposable observation_test DB."""

import json
import os
import subprocess


def query(sql):
    return subprocess.check_output(
        ["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], text=True
    ).strip()


def status():
    return json.loads(query("SELECT row_to_json(s) FROM retrieval.maintenance_status() s"))


def main():
    if os.environ.get("RETRIEVAL_DISPOSABLE_TEST") != "1":
        raise SystemExit("Requires RETRIEVAL_DISPOSABLE_TEST=1; never run on production")
    if query("SELECT current_database()") != "observation_test":
        raise SystemExit("Refusing any database except observation_test")
    if query("SELECT count(*) FROM retrieval.observation") != "0":
        raise SystemExit("Expected empty disposable fixture database")

    query("""INSERT INTO retrieval.observation
      (account_id,id,mode,observed_at,query_fingerprint,text_disposition,snapshot)
      VALUES ('monitor-concurrency','00000000-0000-4000-8000-000000000001','public',
        statement_timestamp()-interval '2161 hours',repeat('a',64),'disabled','{"hits":[]}')""")
    locker = subprocess.Popen(
        ["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        locker.stdin.write("BEGIN; SELECT id FROM retrieval.observation FOR UPDATE; SELECT 'lock_ready';\n")
        locker.stdin.flush()
        while True:
            line = locker.stdout.readline()
            if not line:
                raise RuntimeError("Lock connection exited before acquiring fixture lock")
            if line.strip() == "lock_ready":
                break
        assert query("SELECT retrieval.expire_observations()") == "0"
        locked = status()
        assert locked["last_success_at"] is not None, locked
        assert locked["alarm"] and locked["expired_records"] == 1, locked
    finally:
        if locker.poll() is None:
            locker.communicate("ROLLBACK;\n\\q\n", timeout=10)
        if locker.returncode != 0:
            raise RuntimeError("Fixture lock connection failed")

    assert query("SELECT retrieval.expire_observations()") == "1"
    drained = status()
    assert not drained["alarm"] and drained["expired_records"] == 0, drained
    assert query("SELECT count(*) FROM retrieval.observation") == "0"
    query("DELETE FROM retrieval.maintenance_state")
    print("Committed heartbeat cannot hide locked expired rows; subsequent cleanup clears alarm")


if __name__ == "__main__":
    main()
