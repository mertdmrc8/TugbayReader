@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10 veya daha yeni bir surum gerekli.
  pause
  exit /b 1
)
if exist ".runtime\pymupdf\__init__.py" set "PYTHONPATH=%~dp0.runtime;%PYTHONPATH%"
python -c "from importlib.util import find_spec; raise SystemExit(find_spec('pymupdf') is None)" >nul 2>nul
if errorlevel 1 (
  echo PDF motoru ilk kullanim icin yukleniyor...
  python -m pip install --disable-pip-version-check --target ".runtime" "PyMuPDF==1.28.2"
  if errorlevel 1 (
    pause
    exit /b 1
  )
  set "PYTHONPATH=%~dp0.runtime;%PYTHONPATH%"
)
python app.py
if errorlevel 1 pause
