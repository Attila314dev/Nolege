# Nolege 2.1 — tesztjegyzőkönyv

Ellenőrzés: 2026. október 28., Node.js 24.22.1.

## Automata tesztek

- `npm test`: **52 sikeres teszt, 0 hiba** a beágyazott esetekkel együtt.
- `npm audit --omit=dev`: **0 ismert sérülékenység**.
- `render.yaml`: érvényes a Render aktuális JSON-sémája szerint.
- `git diff --check`: sikeres.

A tesztek ellenőrzik a meghívós belépést, jogosultságokat, kész jelzést, pontozást, újracsatlakozást, néző módot és az importált kérdéscsomagokat is.

Az új ellenőrzések lefedik:

- A Kvízmester tiltását a teljes meccs alatt, az eredményszünetekben és korábbi kérdésre hivatkozva is. A tiltott kérés nem jut el az AI-szolgáltatóhoz.
- Az automatikus fókusznézetet, a kijelző ébren tartásának felszabadítását és a hiányzó vagy tiltott mobilos API-k melletti működést.
- Az AI-állapotot valódi szolgáltatói válasz szimulálásával: a kulcs és a HTTP 200 válasz még nem jelent sikert; a teljes kérdéssornak is érvényesnek kell lennie. Az utolsó hívás időpontja és a tényleges modell neve elérhető, a kulcs nem kerül a válaszba.
- A kezdeti 100 kérdéses készletet API-hívás nélkül; az ismétlésmentes kiosztást és az egyetlen közös háttérfeltöltést legfeljebb 20 kérdéses adaggal.
- A kvóta utáni várakozást, napi háttérfeltöltési korlátot, duplikált kérdések kizárását és a játszható tartalék bankot.
- A készlet, kiosztási előzmény és napi számláló visszaállítását egy új alkalmazáspéldányban. Sikertelen olvasás után a rendszer nem írja felül az ismeretlen távoli állapotot.
- Az egyedi, 20 kérdéses tematikus csomagot, amely nem kerül az általános készletbe. Hibája megőrzi az előző csomagot, és nem vált észrevétlenül általános kvízre.
- A hiányzó nehézségi szinthez szükség esetén külön AI-csomag készítését.

## Böngészős próba

A `tools/browser_smoke.mjs` valódi Chromium böngészővel **hat képernyőméreten** végigjátszott három kérdést:

| Méret | Eredmény |
| --- | --- |
| 375 × 667 | sikeres |
| 390 × 844 | sikeres |
| 412 × 915 | sikeres |
| 768 × 1024 | sikeres |
| 844 × 390 | sikeres |
| 1365 × 900 | sikeres |

Minden méreten ellenőrizve: nincs vízszintes túlcsordulás; legalább 44 px magas válaszgombok; rejtett oldalsáv és chat meccs alatt; megmaradó fókusz az eredményszünetben; működő magyarázat és chat a meccs után. A legkisebb nézetben az oldalfrissítés utáni visszatérés is sikeres. Böngészős JavaScript-hiba nem történt.

Mobilképernyő: `docs/nolege-v2.1-mobile-focus.png`.

Újrafuttatás:

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

Meglévő Chromiumhoz a `CHROMIUM_EXECUTABLE` változó adható meg. Ebben a környezetben a Playwright CDN letöltése hibás archívumokat adott; a sikeres próba az npm-ről származó Chromium 153 binárissal futott. A mobilméret-emuláció és a kompatibilitási tesztek nem helyettesítik a fizikai Android/Safari/iOS készülékpróbát.

## Éles környezet

A kiadás utáni élő ellenőrzés eredménye itt kerül rögzítésre. A fenti AI-tesztek szimulált szolgáltatót használnak; nem fogyasztanak éles API-kvótát.

A külön Free Key Value megőrzi a készletet a webalkalmazás újraindításakor. Magának az ingyenes adattárnak az újraindításakor a tartalma elveszhet; a következő alkalmazásindítás ilyenkor a beépített bankból indul újra.
