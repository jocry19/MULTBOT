@echo off
REM -------------------------------------------------------------------
REM  MULTBOT starten (Windows) - einfach doppelklicken.
REM
REM  Erster Start: richtet alles automatisch ein (1-3 Minuten).
REM   - nutzt vorhandenes Python 3.10+, sonst wird Python automatisch
REM     ueber "uv" (offizielles Tool von Astral) installiert - ohne
REM     Admin-Rechte, nur fuer diesen Benutzer
REM   - installiert die Pakete und legt ein Desktop-Icon "MULTBOT" an
REM  Danach oeffnet sich das Terminal als eigenes App-Fenster.
REM  Dieses schwarze Fenster schliessen = Bot beenden.
REM
REM  Simulation statt Live:   MULTBOT.bat sim
REM  Auch im WLAN (Handy):    MULTBOT.bat run --lan
REM -------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
title MULTBOT - Perp Signal Bot (Paper-Trading)

set "MODE=%~1"
if "%MODE%"=="" set "MODE=run"
set "VPY=.venv\Scripts\python.exe"
set "FIRST="

if exist "%VPY%" goto :deps
set "FIRST=1"
echo.
echo [MULTBOT] Erster Start - richte alles ein (einmalig, ca. 1-3 Minuten) ...
echo.
call :findpython
if not defined PY goto :useuv
echo [MULTBOT] Python gefunden: %PY%
%PY% -m venv .venv
if exist "%VPY%" goto :deps

:useuv
echo [MULTBOT] Kein passendes Python gefunden - installiere Python automatisch (ohne Admin-Rechte) ...
call :getuv
if not defined UV goto :failuv
"%UV%" venv --seed --python 3.12 .venv
if not exist "%VPY%" goto :failuv

:deps
echo [MULTBOT] Pruefe Pakete ...
"%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto :failpip
if defined FIRST "%VPY%" -X utf8 -m multbot shortcut

"%VPY%" -X utf8 -m multbot %MODE% --app %2 %3 %4
echo.
echo [MULTBOT] beendet.
pause
exit /b 0

REM ---------------------------------------------------------------- helpers
:findpython
set "PY="
for %%C in ("py -3.13" "py -3.12" "py -3.11" "py -3.10" "python") do (
  if not defined PY (
    %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=%%~C"
  )
)
exit /b 0

:getuv
set "UV="
for /f "delims=" %%U in ('where uv 2^>nul') do if not defined UV set "UV=%%U"
if defined UV exit /b 0
if exist "%USERPROFILE%\.local\bin\uv.exe" (set "UV=%USERPROFILE%\.local\bin\uv.exe" & exit /b 0)
if exist "%USERPROFILE%\.cargo\bin\uv.exe" (set "UV=%USERPROFILE%\.cargo\bin\uv.exe" & exit /b 0)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
if exist "%USERPROFILE%\.local\bin\uv.exe" (set "UV=%USERPROFILE%\.local\bin\uv.exe" & exit /b 0)
if exist "%USERPROFILE%\.cargo\bin\uv.exe" (set "UV=%USERPROFILE%\.cargo\bin\uv.exe" & exit /b 0)
exit /b 1

:failuv
echo.
echo [MULTBOT] Python konnte nicht automatisch installiert werden.
echo Bitte Python von https://www.python.org/downloads/ installieren
echo (Haken bei "Add python.exe to PATH" setzen) und MULTBOT.bat erneut starten.
start "" "https://www.python.org/downloads/"
pause
exit /b 1

:failpip
echo.
echo [MULTBOT] Installation der Pakete fehlgeschlagen - Internetverbindung pruefen.
echo Zum Neuaufsetzen den Ordner ".venv" loeschen und erneut doppelklicken.
pause
exit /b 1
