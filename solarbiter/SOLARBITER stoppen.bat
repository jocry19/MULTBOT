@echo off
rem Doppelklick (Windows): stoppt SOLARBITER. Datenbank, Einstellungen und Trades bleiben erhalten.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher\launcher.ps1" stop
pause
