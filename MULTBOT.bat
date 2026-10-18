@echo off
REM -------------------------------------------------------------------
REM  MULTBOT starten (Windows) - Doppelklick genuegt.
REM  Beim ersten Start wird automatisch eine Python-Umgebung (.venv)
REM  angelegt und alles installiert. Danach oeffnet sich das Terminal
REM  als eigenes App-Fenster. Dieses Fenster schliessen = Bot beenden.
REM  Simulation statt Live:   MULTBOT.bat sim
REM  Auch im WLAN (Handy):    MULTBOT.bat run --lan
REM -------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title MULTBOT - Perp Signal Bot (Paper-Trading)

set "MODE=%~1"
if "%MODE%"=="" set "MODE=run"

if exist ".venv\Scripts\python.exe" goto :deps

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto :nopython

echo [MULTBOT] Erstinstallation: lege Python-Umgebung an ...
%PY% -m venv .venv || goto :nopython

:deps
echo [MULTBOT] Pruefe Pakete ...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail

".venv\Scripts\python.exe" -X utf8 -m multbot %MODE% --app %2 %3 %4
echo.
echo [MULTBOT] beendet.
pause
exit /b 0

:nopython
echo.
echo [MULTBOT] Python 3.10 oder neuer wurde nicht gefunden.
echo Bitte installieren: https://www.python.org/downloads/
echo Wichtig: beim Installieren den Haken "Add python.exe to PATH" setzen.
echo Danach MULTBOT.bat erneut doppelklicken.
start "" "https://www.python.org/downloads/"
pause
exit /b 1

:fail
echo.
echo [MULTBOT] Installation der Pakete fehlgeschlagen - Internetverbindung pruefen.
pause
exit /b 1
