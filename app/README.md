# Book Animator

Aprire `http://127.0.0.1:8080/app/` con il server del progetto in esecuzione.

## PDF

- **PDF pagine interne**: pagine singole, in ordine di lettura. Pagina 1 sul fronte del primo foglio, pagina 2 sul retro, e così via. Un numero dispari aggiunge un ultimo retro bianco. Il formato e il numero di fogli vengono ricavati dal documento; lo spessore segue il tipo di carta e di copertina. Fino a 2000 pagine.
- **PDF copertina**: riconoscimento automatico, oppure scelta esplicita tra stesa (retro, dorso, fronte da sinistra a destra), pagine separate (fronte, retro, eventuale dorso) e solo fronte. Per una stesa, impostare il formato del libro prima del caricamento. Il valore di abbondanza rimuove il margine esterno, senza ritagliare i giunti del dorso. Un dorso stampato diverso da quello fisico viene segnalato e adattato.
- I file restano nel browser. Il cambio di PDF conserva il libro precedente se il nuovo documento non è leggibile. Per usare un PDF protetto, fornire una copia senza password.
- Le immagini singole restano disponibili nel pannello espandibile.

## Interfaccia

- **Sinistra · Prodotto:** tipo e rilegatura, grafica (PDF e immagini), formato, colori e materiali.
- **Destra · Scena:** animazione (sfoglio e movimento), composizione e soggetto, camera (inquadratura automatica, obiettivo in mm, reinquadra), luce e resa (direzione, altezza, intensità, luce ambiente, ombra, sfondo, qualità, profondità di campo), export, progetto. Sotto i 1280 px si apre col pulsante "Scena".
- **Animazioni pronte** (in cima a Scena): 360° prodotto, 360° camera, tilt, tilt camera, rotazione, capriola, sfoglio classico, sfoglio + 360°, sfoglio rapido, fronte e retro, entrata, pop, caduta, volteggio, sequenza social, camera a mano. Un clic imposta sfoglio, movimento e durata; poi si modificano liberamente.
- **Luce:** luci pronte (studio, finestra, veneziana, sotto gli alberi, tramonto, mezzogiorno, drammatica), direzione, altezza, intensità, temperatura colore, luce ambiente, ombra; ombre proiettate da veneziana, finestra o foglie, anche in movimento.
- **Ambiente e resa:** superfici (legno, cemento, lino, marmo, carta), sfondo in tinta unita, sfumato o fondale da studio, qualità, anteprima veloce (senza occlusione ambientale mentre l'animazione scorre; qualità piena in pausa e negli export), profondità di campo, vignettatura, grana pellicola.
- **Barra sopra il canvas:** ricomincia, pausa, pagina precedente e successiva, reinquadra, PNG, video.
- **Timeline sotto il canvas:** tempo del video; trascinandola si va a quell'istante, calcolato come nell'export.
- **Scorciatoie:** Spazio pausa · R ricomincia · ← → pagine · F reinquadra · P PNG · V video · [ ] fotogramma precedente/successivo.
- **Progetto:** le impostazioni restano salvate nel browser; "Salva" e "Apri" usano un file JSON (PDF e immagini vanno ricaricati); "Ripristina tutto" torna ai valori iniziali.

## Canvas e animazioni

Formati di uscita: **3:4 (1080 × 1440)**, 4:5, 1:1, 9:16 e 16:9, indipendenti dalla finestra e dalla densità dello schermo. L'anteprima viene ridimensionata solo nella visualizzazione.

Prodotti: libro cartonato (dorso tondo o quadro), brossura, brossura filo refe a vista, rilegatura giapponese, spirale wire-o, rivista a punto metallico, opuscolo con cucitura singer, flyer, poster (con listelli in legno, cornice con vetro o clip), pieghevole, biglietto, pieghevole a croce, vinile, roll-up banner, bandiera con vento regolabile, biglietti da visita (si girano), busta con lettera (il lembo si apre, la lettera esce), scatola con coperchio (unboxing), shopper con manici. Composizioni: singolo, coppia, fila di tre, pila, pila alta, ventaglio, cascata, griglia, sparsi, arco, fronte e retro.

Sfoglio e movimento sono indipendenti e si combinano. Sfoglio: no (pagina scelta), sfoglia tutto, sfoglio rapido, apri al centro, solo copertina. Movimento del prodotto: rotazione, giro rapido, sospensione, volteggio, oscillazione, fronte e retro, caduta, entrata laterale, pop, stop-motion. Movimento della camera: panoramica, giro completo, carrellata, avvicinamento, rivelazione, dall'alto, dal basso, vista dall'alto, camera a mano. Sequenze: presentazione, sequenza dinamica. Il ciclo del movimento dura quanto il video. Durante un'animazione l'inquadratura automatica copre l'intero movimento e resta ferma: non segue ogni pagina sollevata. Trascinando la camera si passa al controllo manuale. La sezione Soggetto sposta, ruota e scala il prodotto nel quadro.

PNG alla posa corrente, anche trasparente, a 1× o 2×. Video MP4 H.264 a 24, 30 o 60 fps esatti, qualità 8/16/40 Mbps e motion blur (otturatore a 180°, 4 o 8 istanti per fotogramma), generato fotogramma per fotogramma con WebCodecs (durata da 1 a 60 secondi, pagine PDF sempre complete); nei browser senza WebCodecs la registrazione avviene in tempo reale (MP4 o WebM). Dopo l'export resta un link per scaricare nuovamente il file.

## Implementazione e verifica

PDF.js **5.6.205** è incluso in `vendor/pdfjs`, con worker, font, CMaps, decoder e licenza Apache 2.0. Il modulo viene caricato solo quando serve. [API e rendering di PDF.js](https://mozilla.github.io/pdf.js/examples/).

Le texture delle pagine vengono preparate vicino allo sfoglio e rilasciate quando lontane. Nei libri con più di 40 fogli, quelli fermi usano una geometria ridotta e quelli esposti o in movimento riacquistano la curvatura completa.

Eseguire `node --test app/tests/*.test.cjs` dalla cartella del progetto. `tests/make-pdf-fixtures.py` genera PDF di verifica con 5 e 100 pagine, copertine stese e separate, un file protetto e uno non valido.

## Controlli studio

- **Valori precisi:** ogni slider ha un campo numerico. Invio conferma subito; durante la digitazione l’anteprima si aggiorna dopo una breve pausa. I valori vengono ricondotti ai limiti e al passo del controllo.
- **Materiali e finiture:** opaca, lucida, soft touch e metallizzata, con rugosità, vernice, diffusione, metallizzazione ed effetto vellutato indipendenti. «Da prodotto» ripristina i materiali originali. La finitura riguarda le copertine e le superfici stampate; le pagine interne dei libri conservano la carta scelta. Rilievo e dimensione della fibra sono regolabili. Lo spessore del singolo foglio (0 = automatico) cambia davvero lo spessore del blocco e del dorso; la rigidità modifica la flessione delle pagine.
- **Luci di studio avanzate:** riempimento e controluce indipendenti, ciascuno con intensità, colore, direzione e altezza. Esposizione in EV, rotazione dell’ambiente di riflessione e morbidezza dell’ombra principale. Le luci aggiuntive sono senza ombre per mantenere fluida l’anteprima.
- **Camera:** viste da prodotto, frontale, tre quarti, dall’alto, laterale e retro. Margine dell’inquadratura automatica regolabile, spostamento del fuoco in mm e intensità della sfocatura (con profondità di campo attiva).
- **Movimenti:** ampiezza, fase iniziale e direzione inversa. Agiscono su prodotto/camera; lo sfoglio rimane indipendente. La distanza tra copie regola la composizione.
- **Guide:** terzi, centro e area sicura con margine regolabile. Sono sovrapposte all’anteprima e non entrano nei PNG o nei video.
- **Canvas personalizzato:** scegliere «Personalizzato», inserire larghezza/altezza e premere «Applica dimensioni». Da 256 a 2560 px per lato, pari e compatibili con il limite del dispositivo. PNG fino a 2×. Il canvas iniziale rimane 1080 × 1440.
- **Annulla/ripristina:** pulsanti sopra l’anteprima oppure ⌘/Ctrl Z e ⌘/Ctrl Shift Z fuori dai campi. Fino a 60 stati delle impostazioni nella sessione. File caricati, trascinamento manuale della camera e istante dell’animazione non fanno parte della cronologia. Il JSON conserva le impostazioni, incluse quelle avanzate, ma richiede di ricaricare PDF e immagini.

Avvio locale dalla cartella del progetto: `python3 -m http.server 8080 --bind 127.0.0.1`, quindi aprire `http://127.0.0.1:8080/app/`. L’apertura diretta del file mostra un collegamento all’anteprima locale.

Verifica completa: `node --test app/tests/*.test.cjs app/tests/*.test.mjs`.
