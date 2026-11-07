@echo off
rem Double-click to start Hermes Journey Galaxy. Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 galaxy.py %* & goto :eof)
where python >nul 2>nul && (python galaxy.py %* & goto :eof)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ and double-click this file again.
pause
