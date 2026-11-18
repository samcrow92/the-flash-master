@echo off
rem Create a venv next to this script (first run), install requirements, start Flash Admin.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 ( echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1 )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
)
if not exist ".venv\.req-stamp" (
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || ( pause & exit /b 1 )
  echo ok> ".venv\.req-stamp"
)
start "" ".venv\Scripts\pythonw.exe" -m flashadmin %*
