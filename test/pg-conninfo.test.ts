/**
 * The bash functions that remove the password from a PostgreSQL address for
 * psql (src/app/pg-conninfo.ts). They run under the bash found on PATH; CI runs
 * them under bash 5.x on Linux, and they also run under bash 3.2 on macOS.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { PG_CONNINFO_BASH } from "../src/app/pg-conninfo.ts";

function split(address: string): { status: number | null; conn: string; pw: string } {
  const script = [
    "set -euo pipefail",
    ...PG_CONNINFO_BASH,
    'if samohost_pg_split "$1"; then rc=0; else rc=1; fi',
    "printf 'CONN<%s>\\nPW<%s>\\n' \"$samohost_pg_conn\" \"$samohost_pg_pw\"",
    'exit "$rc"',
  ].join("\n");
  const res = spawnSync("bash", ["-c", script, "split", address], { encoding: "utf8" });
  const conn = /CONN<([\s\S]*?)>\nPW</.exec(res.stdout)?.[1] ?? "<missing>";
  const pw = /PW<([\s\S]*?)>\n$/.exec(res.stdout)?.[1] ?? "<missing>";
  return { status: res.status, conn, pw };
}

describe("percent-decoding of the password", () => {
  test("a%40b%3Ac is decoded to a@b:c", () => {
    expect(split("postgresql://shop_app:a%40b%3Ac@db.internal:6543/shop")).toEqual({
      status: 0,
      conn: "postgresql://shop_app@db.internal:6543/shop",
      pw: "a@b:c",
    });
  });

  test("a literal backslash stays a backslash; %5C becomes a backslash", () => {
    expect(split("postgresql://u:a\\nb%5Cc@h/db").pw).toBe("a\\nb\\c");
  });

  test("a percent sign not followed by two hexadecimal digits stays as it is", () => {
    expect(split("postgresql://u:a%zzb%4@h/db").pw).toBe("a%zzb%4");
    expect(split("postgresql://u:x%@h/db").pw).toBe("x%");
  });

  test("%25 becomes one percent sign and is not decoded a second time", () => {
    expect(split("postgresql://u:a%2541@h/db").pw).toBe("a%41");
  });

  test("%20 becomes a space and + stays +", () => {
    expect(split("postgresql://u:a%20b+c@h/db").pw).toBe("a b+c");
  });

  test("%00 stays as it is", () => {
    expect(split("postgresql://u:a%00b@h/db").pw).toBe("a%00b");
  });
});

describe("address forms", () => {
  test("query parameters such as sslmode=require stay in the address", () => {
    expect(split("postgresql://u:pw@h:5432/db?sslmode=require&connect_timeout=5")).toEqual({
      status: 0,
      conn: "postgresql://u@h:5432/db?sslmode=require&connect_timeout=5",
      pw: "pw",
    });
  });

  test("a password query parameter is removed from the address and decoded", () => {
    expect(split("postgresql://u@h/db?sslmode=require&password=p%40q&application_name=x")).toEqual({
      status: 0,
      conn: "postgresql://u@h/db?sslmode=require&application_name=x",
      pw: "p@q",
    });
  });

  test("an IPv6 literal host is kept", () => {
    expect(split("postgresql://u:pw@[::1]:5432/db")).toEqual({ status: 0, conn: "postgresql://u@[::1]:5432/db", pw: "pw" });
  });

  test("socket-style addresses are kept", () => {
    expect(split("postgresql:///db?host=/var/run/postgresql&user=u")).toEqual({
      status: 0,
      conn: "postgresql:///db?host=/var/run/postgresql&user=u",
      pw: "",
    });
    expect(split("postgresql://u:pw@%2Fvar%2Frun%2Fpostgresql/db")).toEqual({
      status: 0,
      conn: "postgresql://u@%2Fvar%2Frun%2Fpostgresql/db",
      pw: "pw",
    });
  });

  test("the postgres:// scheme is accepted", () => {
    expect(split("postgres://u:a%40b@h/db")).toEqual({ status: 0, conn: "postgres://u@h/db", pw: "a@b" });
  });

  test("an address without a user or a password is kept as it is", () => {
    expect(split("postgresql://h/db")).toEqual({ status: 0, conn: "postgresql://h/db", pw: "" });
    expect(split("postgresql://u@h/db")).toEqual({ status: 0, conn: "postgresql://u@h/db", pw: "" });
  });

  test("a key=value address loses its password pair; quoted values are unquoted as in libpq", () => {
    expect(split("host=127.0.0.1 user=x password='a b\\'c\\\\d' dbname=shop sslmode=require")).toEqual({
      status: 0,
      conn: "host=127.0.0.1 user=x dbname=shop sslmode=require",
      pw: "a b'c\\d",
    });
    expect(split("host = /var/run/postgresql  password = p\\ q dbname='my db'")).toEqual({
      status: 0,
      conn: "host = /var/run/postgresql dbname='my db'",
      pw: "p q",
    });
  });

  test("a key=value address with an unterminated quoted value is refused", () => {
    expect(split("host=h password='abc").status).toBe(1);
  });

  test("a plain database name is kept as it is", () => {
    expect(split("shop")).toEqual({ status: 0, conn: "shop", pw: "" });
  });
});
