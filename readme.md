# Nolege – magyar gyorsasági kvíz

Többjátékos böngészős kvíz, Node.js szerverrel és valós idejű WebSocket-kapcsolattal.

## Játékmenet

- Az admin jelszavas szobát hoz létre, és elindítja a játékot.
- A játékosok a főoldali szobalistából, egyedi 3–12 karakteres névvel csatlakoznak.
- Egy játék 15 véletlen kérdésből áll, a jelenlegi 100 kérdéses készletből.
- Kérdésenként 10 másodperc áll rendelkezésre. Ha minden csatlakozott játékos válaszolt, a kör korábban lezárul.
- A leggyorsabb **helyes** válasz 1 pontot ér. A következő kérdés 3 másodperc múlva indul.
- A jelszó nélküli néző mód TV-n is használható. Menet közbeni belépéskor az aktuális kérdést és a hátralévő időt is megkapja a néző.

## Helyi indítás

Node.js 22 vagy újabb és npm szükséges.

```bash
npm ci
npm start
```

Ezután nyisd meg: <http://localhost:10000>.

Fejlesztéshez, a szerver automatikus újraindításával:

```bash
npm run dev
```

A portot a `PORT` környezeti változóval lehet felülírni. Az állapotjelző végpont: `GET /healthz`.

## Ellenőrzés

```bash
npm test
```

A tesztek külön szervert indítanak szabad porton, és valódi HTTP- és WebSocket-kapcsolatokkal ellenőrzik a belépést, a pontozást és a menet közbeni nézői csatlakozást.

## Render beállítások

A repó Node.js Web Service-ként futtatható, az alábbi beállításokkal:

| Beállítás | Érték |
| --- | --- |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |

A szerver a szolgáltató által megadott `PORT` portot használja. Külön adatbázis nem szükséges.

## Adatok és működés

A kérdések a `questions.json` fájlban vannak. Egy elem a `category`, `question`, `correct` mezőket és legalább három hibás választ tartalmazó `wrong` tömböt tartalmazza. A szerver minden kérdéshez három hibás választ választ, és összekeveri a négy lehetőséget.

A szobák és pontszámok memóriában élnek: szerverújraindításkor elvesznek. A jelenlegi verziót egyetlen szerverpéldánnyal kell futtatni, hogy minden játékos ugyanazokat a szobákat lássa.

A `tools/import_questions.js` és `tools/schema.sql` egy korábbi PostgreSQL-változat maradványa; a jelenlegi szerver nem használja őket. Az importáló nem része az indításnak.
