/**
 * Bash functions that take a PostgreSQL address apart so that psql gets it
 * without the password in its arguments (ps shows process arguments to every
 * user). Used by the assert-rls probe of the deploy script and by the doctor's
 * rls-nonsuperuser probe.
 *
 * samohost_pg_split ADDRESS sets two variables:
 *   samohost_pg_conn  the address without its password; passed to psql -d
 *   samohost_pg_pw    the password, decoded; empty when the address has none
 * and returns 1 when a key=value address has an unterminated quoted value.
 *
 * Accepted forms, the same ones psql accepts as its database argument:
 *   - postgresql:// and postgres:// URIs. The password in the user part
 *     (user:password@) and a password=... query parameter are removed and
 *     percent-decoded; the rest of the URI (host names, IPv6 literals such as
 *     [::1], socket directories, ports, database name and query parameters such
 *     as sslmode=require) goes to psql unchanged. The user part ends at the
 *     first @ before any /, as in libpq.
 *   - key=value strings (host=... user=... password=... dbname=...). The
 *     password pair is removed and its value unquoted as libpq does (single
 *     quotes, backslash escapes); the other pairs go to psql as written.
 *   - anything else (a plain database name) goes to psql unchanged.
 *
 * samohost_pct_decode VALUE sets samohost_pct_out to VALUE with each %XX of
 * two hexadecimal digits replaced by that byte. Every other character stays as
 * it is: a backslash, a + sign, a % that is not followed by two hexadecimal
 * digits, and %00 (a shell variable cannot hold a NUL byte). It works the same
 * on bash 3.2 and bash 5.x: it uses no pattern substitution and no printf %b.
 */
export const PG_CONNINFO_BASH: readonly string[] = [
  "samohost_pct_decode() {",
  '  local s="$1" c h',
  '  samohost_pct_out=""',
  '  while [[ -n "$s" ]]; do',
  '    c="${s:0:1}"',
  '    if [[ "$c" == "%" ]]; then',
  '      h="${s:1:2}"',
  '      case "$h" in',
  "        00) ;;",
  "        [0123456789ABCDEFabcdef][0123456789ABCDEFabcdef])",
  '          printf -v c "\\\\x$h"',
  '          samohost_pct_out+="$c"; s="${s:3}"; continue ;;',
  "      esac",
  "    fi",
  '    samohost_pct_out+="$c"; s="${s:1}"',
  "  done",
  "}",
  "samohost_pg_split() {",
  '  local a="$1" rest userspec user base q kv sep start k v c',
  '  samohost_pg_conn=""; samohost_pg_pw=""',
  '  case "$a" in',
  "    postgresql://*|postgres://*)",
  '      rest="${a#*://}"',
  '      userspec="${rest%%[@/]*}"',
  '      user=""',
  '      if [[ "${rest:${#userspec}:1}" == "@" ]]; then',
  '        rest="${rest:${#userspec}+1}"',
  '        user="${userspec%%:*}"',
  '        if [[ "$userspec" == *:* ]]; then samohost_pct_decode "${userspec#*:}"; samohost_pg_pw="$samohost_pct_out"; fi',
  '        if [[ -n "$user" ]]; then user="$user@"; fi',
  "      fi",
  '      base="${rest%%[?]*}"',
  '      if [[ "$rest" == *[?]* ]]; then',
  '        q="${rest#*[?]}&"; sep="?"',
  '        while [[ -n "$q" ]]; do',
  '          kv="${q%%&*}"; q="${q#*&}"',
  '          samohost_pct_decode "${kv%%=*}"',
  '          if [[ "$samohost_pct_out" == password && "$kv" == *=* ]]; then',
  '            samohost_pct_decode "${kv#*=}"; samohost_pg_pw="$samohost_pct_out"',
  "          else",
  '            base="$base$sep$kv"; sep="&"',
  "          fi",
  "        done",
  "      fi",
  '      samohost_pg_conn="${a%%://*}://$user$base"',
  "      ;;",
  "    *=*)",
  '      rest="$a"',
  "      while :; do",
  '        rest="${rest#"${rest%%[![:space:]]*}"}"',
  '        if [[ -z "$rest" ]]; then break; fi',
  '        start="$rest"',
  '        k="${rest%%[=[:space:]]*}"',
  '        rest="${rest:${#k}}"; rest="${rest#"${rest%%[![:space:]]*}"}"',
  '        if [[ -z "$k" || "${rest:0:1}" != "=" ]]; then return 1; fi',
  '        rest="${rest:1}"; rest="${rest#"${rest%%[![:space:]]*}"}"',
  '        v=""',
  "        if [[ \"${rest:0:1}\" == \"'\" ]]; then",
  '          rest="${rest:1}"',
  "          while :; do",
  '            if [[ -z "$rest" ]]; then return 1; fi',
  '            c="${rest:0:1}"; rest="${rest:1}"',
  "            if [[ \"$c\" == \"'\" ]]; then break; fi",
  '            if [[ "$c" == "\\\\" ]]; then c="${rest:0:1}"; rest="${rest:1}"; fi',
  '            v="$v$c"',
  "          done",
  "        else",
  '          while [[ -n "$rest" ]]; do',
  '            c="${rest:0:1}"',
  '            if [[ "$c" == [[:space:]] ]]; then break; fi',
  '            rest="${rest:1}"',
  '            if [[ "$c" == "\\\\" ]]; then c="${rest:0:1}"; rest="${rest:1}"; fi',
  '            v="$v$c"',
  "          done",
  "        fi",
  '        if [[ "$k" == password ]]; then samohost_pg_pw="$v"; else samohost_pg_conn="$samohost_pg_conn ${start:0:${#start}-${#rest}}"; fi',
  "      done",
  '      samohost_pg_conn="${samohost_pg_conn# }"',
  "      ;;",
  '    *) samohost_pg_conn="$a" ;;',
  "  esac",
  "}",
];
