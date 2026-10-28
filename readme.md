# Nolege 2.1

Magyar, többjátékos partikvíz telefonra és nagy képernyőre. Egy Node.js-szerver, Express, WebSocket; külön adatbázis nélkül is teljesen játszható.

**Alapból általános kvíz, 15 kérdéssel.** A szobagazda minden új fordulóhoz beállíthat témakört, 1–30 kérdést, nehézséget és 10/15/20/30 másodperces válaszidőt.

## Játék és csatlakozás

- Szobanyitás után megjelenik a másolható meghívólink és a QR-kód. A vendégnek egy becenév kell.
- Kézi szobakódos belépéshez választható jelszó. A meghívólink önmagában belépést ad, ezért csak azokkal oszd meg, akiket meg szeretnél hívni.
- A szobagazda akkor indíthat, ha a kérdéssor elfogadott, és minden online játékos készen áll.
- Minden helyes válasz 100 alappontot és legfeljebb 100 gyorsasági bónuszt ér. Hibás vagy kihagyott válasz: 0 pont.
- A kör lezárul, ha minden csatlakozott játékos válaszolt, vagy lejárt az idő. Az eredmény 5 másodpercig látható.
- Az eredmény a teljes helyes választ, rövid magyarázatot, válaszidőket és a kapott pontokat mutatja.
- A meccs elejétől az utolsó eredmény végéig automatikus fókusznézet működik: a kérdés, az idő és a saját pontszám marad előtérben. A meghívó, beállítások és korábbi kérdések a meccs végén térnek vissza.
- Meccs közben a Kvízmester a szerveren is le van tiltva, a kérdések közti eredmény alatt is. A teljes meccs után ismét kérdezhető.
- Androidon és iOS-en is ugyanaz a mobilra igazított fókusznézet működik. A támogató böngészőkben érintéssel teljes képernyőre válthatsz, és a kijelző ébren tartható. A kijelző ébren tartása kikapcsolható, és a meccs végén automatikusan megszűnik. A fókusznézet a weboldalon belüli zavaró elemeket rejti el; nem kapcsolja be a telefon rendszerszintű Ne zavarjanak módját, és nem tiltja az alkalmazásváltást.
- Frissítés és megszakadt WebSocket után ugyanazzal a munkamenettel lehet visszatérni, megőrzött pontszámmal és válasszal.
- A nézők menet közben is beléphetnek, és az aktuális kérdést vagy eredményt azonnal megkapják.
- A szobagazda az elkészült forduló után új kérdéssort készíthet. A lezárt kérdések visszanézhetők.

## AI beállítása

Az élő AI-hoz Renderben add hozzá ezt a környezeti változót:

```text
OPENROUTER_API_KEY = a saját OpenRouter API-kulcsod
# vagy: GROQ_API_KEY = a saját Groq API-kulcsod
```

Kulcs létrehozása: <https://console.groq.com/keys>. Ingyenes használathoz a Groq Free Plan fiókját és kvótáit használd. A beépített modell `openai/gpt-oss-120b`; a kód nem választ fizetős tartalék modellt. A szolgáltató fiókodhoz tartozó tényleges korlátai érvényesek.

Renderben: a Nolege szolgáltatás **Environment → Add Environment Variable → OPENROUTER_API_KEY**, majd **Save, rebuild, and deploy**. A kulcsot a Render titkos beállításában tartsd; az alkalmazás nem küldi böngészőbe és nem írja naplóba. A korábbi szobák az újratelepítéskor megszűnnek.

Ezután:

1. A szobában állítsd be az új forduló témáját, kérdésszámát és nehézségét.
2. Maradjon bekapcsolva az **Egyedi témakört AI-val készítek**, és válaszd az **Új kérdéssor készítése** gombot.
3. Nézd át vagy szerkeszd az előnézetet, és fogadd el a kérdéssort. Az előnézet a megoldásokat is megmutatja.
4. A teljes meccs végén a **Kvízmester** szabad szöveges visszakérdezést is fogad a lezárt kérdésekről.

Az AI a játék előtt készít teljes kérdéssort. A pontozás a rögzített megoldás alapján, a szerveren történik. A chatbot csak már lezárt kérdés megoldását kapja meg, és nem módosíthat pontokat.

### B terv API-kulcs vagy kvóta nélkül

Az alkalmazás jelenleg **140 mentett, magyarázattal és nehézséggel ellátott kérdést** tartalmaz. Általános kvíz, több témakör és legalább 15 kérdéses Harry Potter-kör API nélkül is játszható. Az általános válogatás keveri a témákat és kerüli az ismétlődő főváros/vegyjel/mértékegység sablonokat.

Kulcs nélkül a Kvízmester beépített segédként a mentett magyarázatot és a pontozási szabályokat mutatja. Az eredet mindig látható: **AI-kvízmester** vagy **Beépített segéd**. Hibás, hiányos, időt túllépő vagy kvótába ütköző AI-válasz esetén az általános játék a készletből és a tartalék bankból tovább játszható. Az egyedi témagenerálás hibája megőrzi a korábbi csomagot, és egyértelmű hibaüzenetet ad. A téma nem változik meg észrevétlenül.

Az OpenRouter és a Groq önállóan is használható; elég az egyik kulcs. Az OpenRouter alapértelmezése az `openrouter/free` útvonal, amelyet az opcionális `OPENROUTER_MODEL` felülírhat.

### Kérdéscsomagok mentése

A szobagazda **Mentés** gombja JSON-fájlt tölt le a kérdésekkel és magyarázatokkal. A **Betöltés** gombbal ez később visszaolvasható; a szerver a feltöltött csomagot is ellenőrzi. Így egy jó AI-csomag később újabb API-hívás nélkül játszható.

## Helyi fejlesztés

Node.js 22–24 szükséges; a Render-beállítás és az ellenőrzés Node.js **24.22.1** alatt készült.

```bash
npm ci
npm start
```

Nyisd meg: <http://localhost:10000>.

```bash
npm run dev
npm test
```

Az opcionális helyi `.env` fájlhoz másold le az `.env.example` fájlt. A szerver automatikusan beolvassa. A `.env` nincs verziókövetésben.

## Render

[Nolege telepítése Renderre](https://dashboard.render.com/blueprint/new?repo=https://github.com/Attila314dev/Nolege)

A `render.yaml` egyetlen Free Node.js webszolgáltatást ír le Frankfurtban:

| Beállítás | Érték |
| --- | --- |
| Build | `npm ci` |
| Start | `npm start` |
| Health check | `/healthz` |
| Node.js | `24.22.1` |
| Automatikus telepítés | kikapcsolva |
| Példányszám | 1 |

A szerver a `PORT` környezeti változót használja és `0.0.0.0` címre figyel. A WebSocket ugyanazon a nyilvános címen működik, HTTPS alatt WSS-sel.

Az ingyenes Render szolgáltatás 15 perc bejövő forgalom nélküli idő után leállhat; az ébredés körülbelül egy perc. A szobák és pontok memóriában vannak, szerverújraindításkor elvesznek. Parti előtt nyisd meg az oldalt. Az inaktív szobák két óra után automatikusan bezárulnak. Több szerverpéldányhoz közös állapottárolás kellene; a jelenlegi változat egy példányra készült.

## Ellenőrzés és felépítés

Az integrációs tesztek valódi HTTP- és WebSocket-kapcsolatokkal vizsgálják a meghívót, jelszót, jogosultságokat, kész jelzést, pontozást, visszacsatlakozást, néző módot, teljes játékot, kérdésimportot és a magyarázatok hozzáférését.

Az AI-tesztek szimulált szolgáltatói válaszokkal vizsgálják a teljes generálási és chat-útvonalat, a szigorú JSON-sémát, hibás válaszokat, kvótát, időtúllépést és a tartalék működést. A tesztek nem használnak valódi API-kulcsot. Az éles AI ellenőrzéséhez saját kulcs szükséges.

| Fájl | Feladat |
| --- | --- |
| `lib/server.js` | HTTP, munkamenetek, szobák, WebSocket és játékmenet |
| `lib/questions.js` | bank, válogatás és kérdésellenőrzés |
| `lib/ai.js` | Groq, opcionális OpenRouter és beépített segéd |
| `questions.json`, `extra-questions.json` | mentett kérdések és magyarázatok |
| `public/` | magyar mobilos felület |
| `test/` | automatikus ellenőrzések |

A `tools/import_questions.js` és `tools/schema.sql` korábbi PostgreSQL-es eszközök. A jelenlegi alkalmazás nem használja őket.

Szolgáltatói referencia: [Groq structured outputs](https://console.groq.com/docs/structured-outputs), [Groq limitek](https://console.groq.com/docs/rate-limits), [OpenRouter free router](https://openrouter.ai/openrouter/free), [Render Free](https://render.com/docs/free).

## Nolege 2.1 — focus mode and ready questions

A match automatically enters focus mode for both questions and result intervals. Invitations, settings, sidebars and the question review stay hidden until the match ends. The Quizmaster endpoint also rejects requests during a match, including requests about earlier questions. Fullscreen is optional and requires a tap on supported browsers. Screen wake lock is best effort; unavailable mobile APIs do not prevent play.

The homepage and lobby show the result of the last real AI operation, its completion time and the ready-stock count. A configured API key starts as **unverified**, not healthy. Only a validated response is successful; invalid JSON, incomplete packs, authentication, quota and timeout errors appear as failures. Status polling does not make provider calls. The actual selected model is available in `/api/meta` for diagnostics.

The general pool targets **100** ready questions, seeded from the existing 140-question bank without a provider call. General room creation and preparation allocate a fresh pack immediately. If an exact difficulty has too few saved questions (for example 20 hard ones), an on-demand AI pack can be prepared instead, with the same visible wait and approval as a custom theme. Allocated questions are removed from the pool and recorded to avoid repeat allocations, even when a room is abandoned. At 80 or fewer remaining, a single background refill generates up to 20 questions per batch until the target is reached. Exact duplicates and previously allocated questions are excluded. A provider error waits at least five minutes before retrying; background generation has a separate ceiling of 12 calls per UTC day. The emergency bank keeps general games playable if the fresh pool or quota runs out, with an explicit repeat warning. AI-generated content can still contain factual errors; packs remain editable.

A custom topic such as **Modern popzene** uses a separate temporary pack, never the general pool. Entering a topic suggests 20 questions unless a count was already selected. New topics without a saved pack begin generation in the lobby. The complete pack must pass validation and be accepted by the host. A failed themed request preserves the previous settings and pack and reports the error; it never silently substitutes a general quiz. With AI disabled, known saved topics remain usable from the bank.

### Pool storage

- Local: atomic JSON writes to `data/general-pool.json`, configurable with `QUESTION_POOL_FILE`.
- Render: `REDIS_URL` points to the separate **nolege-question-pool** Key Value instance in Frankfurt. `render.yaml` declares the same reference for future Blueprint syncs. No new AI key is needed.
- The separate store survives web-service redeploys, restarts and idle shutdowns. **Free Key Value has no disk persistence:** a restart of the Key Value instance itself loses its contents. The next app startup safely seeds the built-in bank again. Durable retention across datastore restarts requires a persistent datastore or local persistent storage.
- The app remains playable if storage is unavailable, reports the storage error, and avoids overwriting a remote state it could not read. This setup is designed for one game-server instance, as are the in-memory party rooms.

Optional `OPENROUTER_MODEL` selects a specific model instead of the default `openrouter/free` route. API credentials stay on the server.

Browser regression checks: install Chromium with `npx playwright install chromium`, then run `npm run test:browser`. An existing browser binary can be selected with `CHROMIUM_EXECUTABLE`. These checks emulate mobile screen sizes in Chromium; physical Safari/iOS testing remains separate. Background replenishment runs while the web process is awake and resumes when a sleeping Free service starts again.

Az éles 2.1-es kiadás beállítása: `OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free`. Az ellenőrzéskor az OpenRouter 429 kvótahibát adott; a készletből továbbra is lehet játszani. Az aktuális szolgáltatói hiba és a kérdések forrása a felületen látható.
