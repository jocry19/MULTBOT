@echo off
rem Doppelklick (Windows): startet SOLARBITER in Docker und oeffnet das Dashboard als eigenes App-Fenster.
rem Beim ersten Start entsteht zusaetzlich das Desktop-Symbol "SOLARBITER".
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher\launcher.ps1" start
if errorlevel 1 pause
