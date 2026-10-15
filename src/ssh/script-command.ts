/**
 * Remote command used when a generated shell program is delivered on stdin.
 *
 * Executing the stream directly with `bash -s` leaves the program on FD 0.
 * Any child process that reads stdin (notably npm/Vite) can then consume the
 * unread tail of the deployment program.  Stage the complete stream in a
 * private temporary file first so children inherit an already-exhausted stdin
 * and the shell can reliably execute every phase.
 */
export const REMOTE_STAGED_SCRIPT_COMMAND =
  "umask 077; samohost_script=$(mktemp /tmp/samohost-script.XXXXXX) || exit 1; " +
  "trap 'rm -f \"$samohost_script\"' EXIT HUP INT TERM; " +
  "cat > \"$samohost_script\" || exit 1; " +
  "chmod 700 \"$samohost_script\" || exit 1; " +
  "bash \"$samohost_script\"";
