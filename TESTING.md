# Nolege 3.3 — ellenőrzés

2026. október 31., Node.js 24.22.1.

- `npm test`: **81 sikeres teszt, 0 hiba**.
- `git diff --check`: sikeres.
- A helyi tesztek szimulált AI-válaszokat használnak, éles modellkvótát nem fogyasztanak.

## AI-kapcsolat

Kizárólag Google Gemini. Alapmodell: `gemini-3.1-flash-lite`, a szerveroldali `GEMINI_MODEL` felülírhatja. Sémás kérdésgenerálás, pontos darabszám, eltérő válaszok, magyarázat, nehézség és duplikációk ellenőrzése. A passzív modelllekérdezés nem számít inferenciának; a kapcsolatteszt igen. A számlálók a Google válaszából készülnek. Egy sikertelen kérés egyetlen modellhívás marad. A napi és rövidebb kvótakorlát, várakozási idő, hibás kulcs, hiányzó modell, szöveges vagy tömbbe csomagolt hibaválasz és időtúllépés kezelése tesztelt. A kulcsok kitakarva jelennek meg; siker után a régi hibajelzés törlődik.

Az adminban egy Gemini-kártya, valós modellnév és AI Studio kvótahivatkozás látszik. A háttérfeltöltés öt kérdéses csomagokat készít ellenőrzendőként. A generált kérdések eredeti forrása, szolgáltatója és modellje megmarad; automatikus jóváhagyás nincs. Az admin-beállítások csak a háttérfeltöltés engedélyezését tárolják; a korábbi mentések további beállításai olvasáskor elhagyhatók a kérdések megváltoztatása nélkül.

## Adatok és szerver

A tartós bankban jelenleg legalább 945 kérdés van: 140 korábbi, 800 ChatGPT-forrású és 5 Gemini-próbakérdés. Az aktuális jóváhagyási állapotot a tulajdonos kezeli. A tesztminták ezt nem írják át. A katalógus szerkezete, egyedi kérdésszövegek, különböző válaszok, forrás és készítő, illetve a matematikai kártyák egy részének számítása ellenőrzött; ez nem teljes körű tényellenőrzés.

Admin: belépésvédelem, külön tulajdonosi és asszisztensi hozzáférés, HttpOnly cookie, CSRF, Origin, belépési korlátozás, verzióütközés és duplikációszűrés. Szerkesztés, import, jóváhagyás, archiválás, ellenőrzőösszeges mentés és visszaállítás, napló. A GitHub-tároló SHA-ellenőrzéssel ír; olvasási hiba után nem írja felül a távoli bankot. A nagy fájlok pontos blobjának olvasását a teszt az aktuális bankmérettel ellenőrzi.

A meccs alatti fókusz, tiltott Kvízmester, pontozás, meghívó, késői néző, újracsatlakozás, új forduló, gyors készlet és feltöltési keret továbbra is tesztelt. A hangokhoz nincs külső API-hívás; a hangtól, témaváltástól, telepítési segédtől és konfettitől függetlenül a mentett bank játszható marad.

## Böngésző

A `tools/admin_browser_smoke.mjs` Chromiumban hat méretet ellenőriz: 375 × 667, 390 × 844, 412 × 915, 768 × 1024, 844 × 390 és 1365 × 900. Lefedett: belépés, kérdéslista, szűrés, szerkesztő, egyetlen Gemini-kártya, egyszerű háttérfeltöltési beállítás, kvótahivatkozás, nulla inferencia állapotfrissítéskor, explicit kapcsolatteszt, AI-előnézet, review-import, mentés és visszaállítás, duplikáció, napló és kijelentkezés. Minden írás elkülönített memóriabeli bankot érint. Nincs vízszintes túlcsordulás vagy böngészős futási hiba.

A korábban ellenőrzött játék- és élménypróba továbbra is külön futtatható. A méretemuláció nem fizikai Android/iOS/Safari-próba.

```bash
npm ci
npx playwright install chromium
npm test
npm run test:admin-browser
npm run test:browser
npm run test:experience-browser
```

Meglévő Chromiumhoz `CHROMIUM_EXECUTABLE` adható meg. Képek: `docs/nolege-admin-gemini-mobile.png`, `docs/nolege-admin-gemini-desktop.png`.
