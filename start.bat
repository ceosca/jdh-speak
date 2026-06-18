@echo off
REM ============================================================
REM  JDH Speak - arranque local (Windows)
REM  Lanza el server (tsx watch :3100) y el client (Vite :5173)
REM  en dos ventanas separadas, usando pnpm via corepack
REM  (no requiere pnpm instalado en el PATH ni permisos de admin).
REM ============================================================

cd /d "%~dp0"

echo Arrancando JDH Speak...
echo   Server: http://localhost:3100
echo   Client: http://localhost:5173
echo.

start "JDH Speak server" cmd /k corepack pnpm --filter server exec tsx watch src/index.ts
start "JDH Speak client" cmd /k corepack pnpm --filter client exec vite

echo Dos ventanas abiertas (server y client).
echo Abre http://localhost:5173 en el navegador.
echo Cierra cada ventana para detener su proceso.
