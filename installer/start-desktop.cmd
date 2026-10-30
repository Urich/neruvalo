@echo off
setlocal
cd /d "%~dp0"
rem Schema 2 uses a separate prototype cache. Old caches are never deleted.
set "NERUVALO_CLIENT_DIR=%~dp0local-data\client-v04"
"%~dp0neruvalo-desktop.exe" %*
