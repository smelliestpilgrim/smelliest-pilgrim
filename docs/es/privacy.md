---
title: Declaración de privacidad de Smelliest Pilgrim
lang: es
---

# Declaración de privacidad de Smelliest Pilgrim

*[English](../privacy.html)*

Última actualización: 27 de noviembre de 2026

Esta declaración cubre la app de reloj **Smelliest Pilgrim** (Zepp OS, Amazfit
T-Rex 3), su página de ajustes en la app Zepp, la app de Android **Smelliest
Pilgrim** (antes llamada WatchMemo) y el servidor opcional que puedes alojar tú
mismo, incluido en el mismo repositorio. Las hace una sola persona
(smelliestpilgrim en GitHub, smilingpilgrim en la plataforma de desarrolladores
de Zepp) y se comparten gratis como código abierto.

## Qué datos recogen las apps

- **Grabaciones de voz** que tú inicias en el reloj.
- **Ubicación**: la posición GPS del reloj al grabar una nota, si das el permiso
  de ubicación. Se guarda como latitud y longitud junto a la nota.
- **Datos de la grabación**: hora, duración, cómo se detuvo la grabación y un
  breve registro técnico de la app del reloj (para averiguar por qué falló un
  envío).

Nada más: ni contactos, ni datos de salud, ni identificadores, ni analítica, ni
anuncios, ni rastreo.

## Adónde van

- En el **reloj**, las notas se guardan en el almacenamiento propio de la app
  hasta que se envían, se confirman y tú las borras.
- Cuando pulsas **Send**, el reloj pasa cada nota por Bluetooth a la app oficial
  Zepp de tu móvil, que la entrega al destino que elegiste en la app Zepp
  (Smelliest Pilgrim > Ajustes):
  - **App de móvil Smelliest Pilgrim** (por defecto): la app de Android del
    mismo móvil, en la dirección local 127.0.0.1. Nada sale de tu teléfono. La
    app guarda las notas en su almacenamiento privado y escribe un zip por día
    en `Documents/WatchMemos`.
  - **My server** (Mi servidor, opcional): una dirección de servidor y un token que
    introduces **tú**. Las notas se envían por HTTPS solo a ese servidor. Tú
    controlas ese servidor y lo que pasa allí con los datos. Si usas el servidor
    de este repositorio en Cloudflare, las notas se guardan en tu propia cuenta
    de Cloudflare.
- **Nombres de pueblos opcionales** (app del móvil, desactivados por defecto):
  si los activas, la app pregunta al Geocoder integrado de Android por el pueblo
  de la posición de cada nota. En la mayoría de los móviles es un servicio en
  línea de Google, que recibe las coordenadas (redondeadas a unos 100 m). Los
  resultados se guardan, así que cada lugar se consulta una sola vez. Si lo
  dejas desactivado, nada sale del teléfono.
- **Abrir en Mapas** (app del móvil) pasa las coordenadas de una nota a la app
  de mapas o al navegador que elijas, solo cuando lo tocas.
- **El desarrollador no recibe nada.** No hay ningún servidor del desarrollador,
  y estas apps no envían datos al desarrollador ni a terceros.

La app Zepp es de Zepp Health y tiene su propia política de privacidad, que
cubre la conexión Bluetooth que proporciona.

## Conservación y borrado

- Borra las notas del reloj desde la app (una vez enviadas).
- Borra las notas del móvil en la app del móvil o borrando los zips de cada día;
  o desinstala la app del móvil para eliminar todo lo que guardó.
- En tu propio servidor, usa su página de notas (Delete) o borra allí los datos.

## Permisos

- Reloj: micrófono (para grabar), ubicación (para etiquetar las notas),
  almacenamiento local.
- Android: acceso a la red (para recibir las notas de la app Zepp en el mismo
  móvil, en 127.0.0.1, y para los nombres de pueblos opcionales); solo en
  Android 8 y 9, permiso de escritura en el almacenamiento para los zips.

## Menores

Las apps no están dirigidas a menores.

## Contacto

Abre una incidencia en
[github.com/smelliestpilgrim/smelliest-pilgrim/issues](https://github.com/smelliestpilgrim/smelliest-pilgrim/issues).
