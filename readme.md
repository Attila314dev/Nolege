# Nolege 2.0

Magyar, többjátékos partikvíz telefonra és nagy képernyőre. Egy Node.js-szerver, Express, WebSocket; külön adatbázis nélkül is teljesen játszható.

**Alapból általános kvíz, 15 kérdéssel.** A szobagazda minden új fordulóhoz beállíthat témakört, 1–30 kérdést, nehézséget és 10/15/20/30 másodperces válaszidőt.

## Játék és csatlakozás

- Szobanyitás után megjelenik a másolható meghívólink és a QR-kód. A vendégnek egy becenév kell.
- Kézi szobakódos belépéshez választható jelszó. A meghívólink önmagában belépést ad, ezért csak azokkal oszd meg, akiket meg szeretnél hívni.
- A szobagazda akkor indíthat, ha a kérdéssor elfogadott, és minden online játékos készen áll.
- Minden helyes válasz 100 alappontot és legfeljebb 100 gyorsasági bónuszt ér. Hibás vagy kihagyott válasz: 0 pont.
- A kör lezárul, ha minden csatlakozott játékos válaszolt, vagy lejárt az idő. Az eredmény 5 másodpercig látható.
- Az eredmény a teljes helyes választ, rövid magyarázatot, válaszidőket és a kapott pontokat mutatja.
- Frissítés és megszakadt WebSocket után ugyanazzal a munkamenettel lehet visszatérni, megőrzött pontszámmal és válasszal.
- A nézők menet közben is beléphetnek, és az aktuális kérdést vagy eredményt azonnal megkapják.
- A szobagazda az elkészült forduló után új kérdéssort készíthet. A lezárt kérdések visszanézhetők.

## AI: egyetlen beállítás hiányzik

Az élő AI-hoz Renderben add hozzá ezt a környezeti változót:

```text
GROQ_API_KEY = a saját Groq API-kulcsod
```

Kulcs létrehozása: <https://console.groq.com/keys>. Ingyenes használathoz a Groq Free Plan fiókját és kvótáit használd. A beépített modell `openai/gpt-oss-120b`; a kód nem választ fizetős tartalék modellt. A szolgáltató fiókodhoz tartozó tényleges korlátai érvényesek.

Renderben: a Nolege szolgáltatás **Environment → Add Environment Variable → GROQ_API_KEY**, majd **Save, rebuild, and deploy**. A kulcsot a Render titkos beállításában tartsd; az alkalmazás nem küldi böngészőbe és nem írja naplóba. A korábbi szobák az újratelepítéskor megszűnnek.

Ezután:

1. A szobában állítsd be az új forduló témáját, kérdésszámát és nehézségét.
2. Maradjon bekapcsolva az **AI-val, ha elérhető**, és válaszd az **Új kérdéssor készítése** gombot.
3. Nézd át vagy szerkeszd az előnézetet, és fogadd el a kérdéssort. Az előnézet a megoldásokat is megmutatja.
4. A már lezárt kérdéseknél a **Kvízmester** szabad szöveges visszakérdezést is fogad.

Az AI a játék előtt készít teljes kérdéssort. A pontozás a rögzített megoldás alapján, a szerveren történik. A chatbot csak már lezárt kérdés megoldását kapja meg, és nem módosíthat pontokat.

### B terv API-kulcs vagy kvóta nélkül

Az alkalmazás jelenleg **140 mentett, magyarázattal és nehézséggel ellátott kérdést** tartalmaz. Általános kvíz, több témakör és legalább 15 kérdéses Harry Potter-kör API nélkül is játszható. Az általános válogatás keveri a témákat és kerüli az ismétlődő főváros/vegyjel/mértékegység sablonokat.

Kulcs nélkül a Kvízmester beépített segédként a mentett magyarázatot és a pontozási szabályokat mutatja. Az eredet mindig látható: **AI-kvízmester** vagy **Beépített segéd**. Hibás, hiányos, időt túllépő vagy kvótába ütköző AI-válasz esetén a szerver a megfelelő témájú bankból készít tartalékot, ha abban elegendő kérdés van. Ha nincs megfelelő bank, megőrzi a korábbi kérdéssort, és jelzi, hogy másik téma vagy kevesebb kérdés szükséges.

Opcionális második szolgáltató: `OPENROUTER_API_KEY`. Ehhez kizárólag az `openrouter/free` modellútvonalat használja. Elég csak a Groq-kulcsot beállítani.

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
