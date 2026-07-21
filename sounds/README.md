# Sonidos de eventos (opcionales, por despliegue)

Coloca aquí archivos de audio para **reemplazar los sonidos sintetizados** de la
app. Si un cue tiene archivo, **todos los clientes** lo reproducen localmente al
ocurrir el evento (mismo camino local que el sonido sintetizado: **no** se
transmite por la llamada, cada quien lo oye por sus propios altavoces). Si un cue
**no** tiene archivo, se usa el sonido sintetizado de siempre.

No hace falta recompilar el cliente: el servidor sirve esta carpeta en `/sounds`.
Basta con dejar el archivo aquí (en la Raspberry, `/home/pi/jdh-speak/sounds/`).
Tras añadir la carpeta por primera vez hay que reiniciar el servidor una vez;
después, reemplazar/añadir archivos no requiere reinicio (recarga forzada en el
navegador para saltar la caché).

## Nombres reconocidos

`<cue>.mp3` (o `.wav` / `.ogg`). El cliente prueba las extensiones en ese orden.

| Archivo            | Cuándo suena                                   |
|--------------------|------------------------------------------------|
| `join`             | alguien entra a la sala                        |
| `leave`            | alguien sale                                    |
| `message`          | mensaje de chat entrante                        |
| `mute`             | te silencias                                    |
| `unmute`           | quitas tu silencio                              |
| `peer-mute`        | otro participante se silencia                   |
| `peer-unmute`      | otro participante quita su silencio             |
| `thunk`            | acción bloqueada (p. ej. chat rate-limitado)    |
| `share-start`      | empieza a compartirse audio                      |
| `share-stop`       | deja de compartirse audio                        |
| `zumbido`          | alguien envía un zumbido (botón del chat o Alt+Z) |
| `typing` ⌨          | **una vez por TECLA** pulsada en el chat        |

⌨ **`typing` suena una vez por cada tecla**, no en bucle. Así lo que se oye es el
**ritmo real** de quien escribe: una letra suelta = un solo golpecito; escribir
rápido = ráfaga. Lo oyen todos, incluido quien escribe.

- Usa un archivo **muy corto** (~0,1–0,2 s): es **un golpe de tecla**, no una
  grabación de alguien tecleando. Un archivo largo se solapará consigo mismo.
- Cada golpe se reproduce con un **tono ligeramente aleatorio** para que una
  ráfaga no suene a máquina repitiendo el mismo clic.
- A diferencia del resto, **no tiene sonido sintetizado de repuesto**: sin
  archivo, simplemente no suena.

Ejemplo: para cambiar solo entrada/salida, deja `join.mp3` y `leave.mp3` aquí; el
resto seguirá sintetizado.

## Recomendaciones

- Archivos **cortos** (< 1–2 s) y **normalizados** en volumen (se reproducen tal
  cual, sin ajuste automático).
- Formatos: MP3, WAV u OGG. MP3 pesa menos.
- Los archivos de audio de esta carpeta **no** se versionan en git (solo este
  README); son específicos de cada despliegue.
