@echo off
setlocal
cd /d "%~dp0"
if not exist "local-data" mkdir "local-data"
set "NERUVALO_DEV_MODE=true"
set "DATABASE_URL=sqlite://local-data/server.sqlite3?mode=rwc"
set "NERUVALO_DEV_OUTBOX=local-data/dev-outbox"
set "NERUVALO_LISTEN=127.0.0.1:8787"
echo Neruvalo prototype server: http://127.0.0.1:8787
echo Test data only. Email confirmation codes: local-data\dev-outbox
echo Keep this window open while testing the desktop application.
"%~dp0neruvalo-server.exe"
echo Server stopped.
pause
