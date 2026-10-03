@echo off
rem Doppelklick (Windows): startet SOLARBITER in Docker und oeffnet das Dashboard im Browser.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher\launcher.ps1" start
pause
