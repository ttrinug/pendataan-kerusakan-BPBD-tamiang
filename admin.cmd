@echo off
rem Starts the local admin (review page and Dashboard tools) and opens it in the browser.
rem Double-click this file. Close its window to stop the admin.
rem (For testing: set NO_BROWSER=1 to skip opening the browser.)
title Tinjauan Survei Kerusakan - tutup jendela ini untuk berhenti
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js tidak ditemukan di komputer ini. Pasang dari https://nodejs.org lalu coba lagi.
  pause
  exit /b 1
)

rem Already running? Then only open the page.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8082/admin/ | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo Halaman tinjauan sudah berjalan.
  if not defined NO_BROWSER start "" "http://localhost:8082/admin/"
  timeout /t 3 >nul
  exit /b 0
)

rem Open the browser two seconds from now, once the server is listening.
if not defined NO_BROWSER start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8082/admin/'"

echo Halaman tinjauan: http://localhost:8082/admin/
echo Alat dasbor:      http://localhost:8082/admin/dasbor.html
echo Aplikasi survei:  http://localhost:8082/Survey/
echo Dashboard:        http://localhost:8082/Dashboard/
echo Biarkan jendela ini terbuka selama bekerja. Tutup untuk berhenti.
echo.
node admin\server.mjs
echo.
echo Halaman admin sudah berhenti.
pause
