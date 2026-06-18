@echo off
REM ============================================================
REM  SonicRoom - arranque local (Windows)
REM  Lanza el server (tsx watch :3100) y el client (Vite :5173)
REM  en dos ventanas separadas, usando pnpm via corepack
REM  (no requiere pnpm instalado en el PATH ni permisos de admin).
REM ============================================================

cd /d "%~dp0"

echo Arrancando SonicRoom...
echo   Server: http://localhost:3100
echo   Client: http://localhost:5173
echo.

start "SonicRoom server" cmd /k corepack pnpm --filter server exec tsx watch src/index.ts
start "SonicRoom client" cmd /k corepack pnpm --filter client exec vite

echo Dos ventanas abiertas (server y client).
echo Abre http://localhost:5173 en el navegador.
echo Cierra cada ventana para detener su proceso.
