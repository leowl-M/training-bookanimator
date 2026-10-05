# Book Animator Studio

Studio nel browser per creare mockup 3D di libri, prodotti stampati e packaging, con PDF per gli interni e la copertina, materiali, luci, camera, animazioni ed export PNG/video.

## Avvio locale

Dalla cartella del progetto:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Aprire [Book Animator Studio](http://127.0.0.1:8080/app/). L'app richiede un server HTTP: aprire direttamente i file HTML non è sufficiente per i moduli e i PDF.

Non serve una compilazione. Three.js, Tailwind, Lucide e il muxer MP4 vengono caricati da CDN; PDF.js è incluso nel progetto. È quindi richiesta una connessione a Internet per il caricamento iniziale delle librerie esterne. I PDF e le immagini caricati vengono elaborati nel browser.

## Struttura

- `app/`: applicazione e documentazione dettagliata.
- `app/vendor/pdfjs/`: PDF.js con risorse e licenza.
- `app/tests/`: verifiche automatiche e PDF di esempio per i test.
- `index.html`: ingresso che apre l'applicazione.

Le istruzioni per i controlli, i PDF, le animazioni e gli export sono in [app/README.md](app/README.md).

## Verifiche

Con Node.js installato, dalla cartella del progetto:

```sh
node --test app/tests/*.test.cjs app/tests/*.test.mjs
```

## GitHub Pages

Caricare il contenuto di questa cartella nel repository. In **Settings → Pages**, scegliere **Deploy from a branch**, il branch del progetto e la cartella **/(root)**. L'ingresso apre automaticamente `app/index.html`.

I file JSON di progetto salvano le impostazioni; PDF e immagini devono essere ricaricati quando si riapre un progetto.
