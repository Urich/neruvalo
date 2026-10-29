#!/usr/bin/env bash
# Neruvalo prototype: an interactive, loopback-only installation from a source checkout.
set -euo pipefail
umask 077
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sqlite_url() {
 local LC_ALL=C filename=$1 encoded='' byte index
 for ((index=0; index<${#filename}; index++)); do
  printf -v byte '%%%02X' "'${filename:index:1}"
  encoded+=$byte
 done
 printf 'sqlite:%s?mode=rwc' "$encoded"
}
command -v cargo >/dev/null || { echo 'Install Rust (stable) and rerun. See docs/prototype.ru.md.' >&2; exit 1; }
command -v cc >/dev/null || { echo 'A C compiler is required to build bundled SQLite.' >&2; exit 1; }
echo 'Neruvalo development prototype — TEST DATA ONLY.'
echo 'This script does not configure public access, SMTP or CAPTCHA.'
read -r -p "Installation directory [$HOME/neruvalo-prototype]: " install_dir
install_dir=${install_dir:-"$HOME/neruvalo-prototype"}
[[ $install_dir = /* && $install_dir != *$'\n'* ]] || { echo 'Use an absolute path without newlines.' >&2; exit 1; }
[[ ! -e "$install_dir" ]] || { echo 'Target already exists; no files were changed.' >&2; exit 1; }
read -r -p 'Database: 1) SQLite  2) existing PostgreSQL [1]: ' database_choice
case ${database_choice:-1} in
 1) database_url=$(sqlite_url "$install_dir/data/server.sqlite3") ;;
 2) read -r -s -p 'PostgreSQL URL (dedicated EMPTY database; hidden): ' database_url; echo
    [[ $database_url == postgres://* || $database_url == postgresql://* ]] || { echo 'Invalid PostgreSQL URL.' >&2; exit 1; } ;;
 *) echo 'Unknown choice.' >&2; exit 1 ;;
esac
read -r -p 'Loopback TCP port [8787]: ' port
port=${port:-8787}
[[ $port =~ ^[0-9]+$ ]] && ((port>=1024 && port<=65535)) || { echo 'Invalid port.' >&2; exit 1; }
printf '\nDirectory: %s\nListener: 127.0.0.1:%s\nDatabase choice: %s\n' "$install_dir" "$port" "${database_choice:-1}"
read -r -p 'Build and install this prototype? [y/N]: ' answer
[[ $answer == y || $answer == Y ]] || { echo 'Cancelled.'; exit 0; }
(cd "$root_dir" && cargo build --locked --release -p neruvalo-server)
mkdir -p -- "$install_dir/bin" "$install_dir/data" "$install_dir/dev-outbox"
cp -- "$root_dir/target/release/neruvalo-server" "$install_dir/bin/"
{
 printf 'export NERUVALO_DEV_MODE=true\n'
 printf 'export DATABASE_URL=%q\n' "$database_url"
 printf 'export NERUVALO_LISTEN=%q\n' "127.0.0.1:$port"
 printf 'export NERUVALO_DEV_OUTBOX=%q\n' "$install_dir/dev-outbox"
} > "$install_dir/server.env"
cat > "$install_dir/run.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
umask 077
install_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$install_dir/server.env"
cd "$install_dir"
exec "$install_dir/bin/neruvalo-server"
RUN
chmod 700 "$install_dir/run.sh"
printf '\nInstalled. Start manually: %q\nEmail confirmation files: %s/dev-outbox\n' "$install_dir/run.sh" "$install_dir"
echo 'No service was enabled. No existing installation was overwritten. Keep this server on loopback.'
