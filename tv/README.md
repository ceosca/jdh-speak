# Canales de TV en vivo (`tv/db.json`)

El servidor sirve este archivo en `GET /api/tv-channels`. **No** se versiona
(puede tener llaves DRM). Editalo a mano para agregar/quitar canales — sin
recompilar ni reiniciar (el endpoint relee cuando cambia el archivo).

`db.json` es un array. Cada canal:

```json
{
  "nombre": "TELEFE AMBA",
  "categoria": "Argentina",
  "url": "https://.../variant.mpd",
  "key": "KID_hex:LLAVE_hex"
}
```

- `categoria` agrupa los canales (encabezados en la app).
- `url` es un manifiesto DASH (`.mpd`).
- `key` es la ClearKey en formato `kid:key` (hex:hex); Shaka la usa para descifrar
  en el navegador. Requiere Chrome (EME/ClearKey).
