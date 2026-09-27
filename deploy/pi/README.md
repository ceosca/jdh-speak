# Configuración del Pi (copia de referencia para rollback)

Copia de los archivos de sistema que hacen andar JDH Speak en la Raspberry Pi
(`pi@192.168.4.2`, dominio `jdh.privatedns.org`) y que viven **fuera** del repo.
Sirve para restaurarlos si se rompen o se pierden. Tomada el 2026-09-27.

**No es la fuente de verdad**: lo que manda es lo que está en el Pi. Si cambiás algo
allá, volvé a copiarlo acá y commitealo.

## Qué hay y dónde va en el Pi

| En el repo                                      | En el Pi                          | Qué es                                                                                |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `systemd/sonicroom.service`                     | `/etc/systemd/system/`            | El servicio de la app (en este Pi se llama `sonicroom`, no `jdh-speak`)               |
| `systemd/sonicroom-healthcheck.{service,timer}` | `/etc/systemd/system/`            | Watchdog cada 60 s: revive la app si se cuelga o queda `failed`                       |
| `bin/sonicroom-healthcheck.sh`                  | `/usr/local/bin/`                 | Script del watchdog                                                                   |
| `systemd/sonicroom-announce-ip.{service,timer}` | `/etc/systemd/system/`            | Cada 10 min revisa la IP pública                                                      |
| `bin/sonicroom-announce-ip.sh`                  | `/usr/local/bin/`                 | Actualiza `ANNOUNCED_IP` del `.env` y `external-ip` de coturn si la IP pública cambió |
| `caddy/Caddyfile`                               | `/etc/caddy/Caddyfile`            | Dominio → `:3100`, feed de JustWatch → `:3200`, página de mantenimiento, sin HTTP/3   |
| `coturn/turnserver.conf`                        | `/etc/turnserver.conf`            | Nuestro TURN (ver `docs/turn-server.md`)                                              |
| `maintenance/index.html`                        | `/var/www/maintenance/index.html` | Página que muestra Caddy si la app está caída                                         |

## Datos censurados (completar al restaurar)

- `caddy/Caddyfile`: `<TU_EMAIL_ACME>` → el email de la cuenta ACME.
- `coturn/turnserver.conf`: `user=` → usuario:clave del TURN (los mismos que
  `TURN_USERNAME` / `TURN_CREDENTIAL` del `.env`); `<IP_PUBLICA>` → la IP pública
  (el timer `sonicroom-announce-ip` la corrige solo).

## Lo que NO está en git (tiene secretos o es contenido del operador)

- `/home/pi/jdh-speak/.env` — IPs, TURN, notificaciones. Plantilla: `.env.example`.
- `/home/pi/jdh-speak/tv/db.json` — canales de TV con claves ClearKey (`tv/README.md`).
- `/home/pi/jdh-speak/sounds/*.mp3` — sonidos de entrar/salir/mensaje (`sounds/README.md`).

## Restaurar

```bash
sudo cp systemd/* /etc/systemd/system/
sudo install -m 755 bin/*.sh /usr/local/bin/
sudo cp caddy/Caddyfile /etc/caddy/Caddyfile            # completar el email
sudo cp coturn/turnserver.conf /etc/turnserver.conf     # completar user= y la IP
sudo cp maintenance/index.html /var/www/maintenance/index.html
sudo systemctl daemon-reload
sudo systemctl enable --now sonicroom sonicroom-healthcheck.timer sonicroom-announce-ip.timer
sudo systemctl reload caddy && sudo systemctl restart coturn
```

## Rollback del código

El código que corre es el commit que tenga `/home/pi/jdh-speak`:

```bash
cd /home/pi/jdh-speak && git checkout <commit> && pnpm install && pnpm --filter client build
sudo systemctl restart sonicroom
```

Ojo: la unidad tiene `PrivateTmp=true`, así que las grabaciones en curso viven en el `/tmp`
privado del servicio (no en el `/tmp` que ves por ssh).
