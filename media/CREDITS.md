# Bundled media

## Voices

`voice-1.wav` … `voice-5.wav` are real recordings of five different men taken
from the **AMI Meeting Corpus**, which records people holding actual meetings.
Each file is one participant's close-talk headset channel, with the silence
where others were speaking removed, so it plays as that person talking
continuously.

- Source: AMI Meeting Corpus — https://groups.inf.ed.ac.uk/ami/corpus/
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0)
- https://creativecommons.org/licenses/by/4.0/

| File | Recording | Channel |
| --- | --- | --- |
| voice-1.wav | TS3003a | Headset-0 |
| voice-2.wav | IS1000a | Headset-1 |
| voice-3.wav | ES2004a | Headset-0 |
| voice-4.wav | TS3005a | Headset-0 |
| voice-5.wav | TS3009a | Headset-0 |

Changes made: a section of each channel was extracted, silence between that
speaker's turns removed, loudness normalised, and the result trimmed. Kept at
the original 16 kHz mono.

## Shared screen

`screen.webm` is the footage a bot shares when it shares a screen: a bumblebee
on an Indian Blanket flower in a wildflower meadow.

- Source: Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Flowers_(20210715-FPAC-KLS-0001).webm
- Author: USDAgov
- Licence: Public domain (work of the U.S. federal government)

Changes made: cropped from 1920x1300 to 1920x1080 to drop the letterbox bars
and a burned-in caption, trimmed to 16s, saturation lifted slightly, the tail
dissolved into the head so it loops without a cut, and re-encoded to VP9.
Already 30fps at source, so no retiming was needed. No audio.

## Camera clips

`clip-1` … `clip-5` are stock video of five different people at a desk, used as
each bot's camera. They were downloaded from Pexels by the project owner; the
source files carried Pexels video IDs **5941016, 7261921, 7643836, 7706881,
8048255** (https://www.pexels.com/video/<id>/). Which ID became which clip was
not recorded.

- Licence: Pexels License — https://www.pexels.com/license/
  Free to use, attribution not required. Note its limits: do not sell unaltered
  copies, and do not redistribute the footage on stock or wallpaper platforms.

Changes made: scaled and cropped to 1920x1080, 30fps, 8s, encoded as MJPEG,
which is the format Chrome's fake camera accepts.

To replace them, put your own videos in a folder and run:

    node scripts/import-videos.mjs <folder> --bundle
