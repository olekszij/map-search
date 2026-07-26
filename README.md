# Maps Lead Scraper 2.2

Semi-automatic Google Maps Chrome scraper: live table like Instant Data Scraper, filters, append/dedupe, pause, sessions, Excel/TSV, website check, Google Sheet export.

## Installation

1. `chrome://extensions` → Developer mode → **Load unpacked**
2. Select folder `map-search` (where `manifest.json` is)
3. Open Maps → F5 after extension update

## How to use

1. Zoom to area → **«Rechercher dans cette zone»**
2. On panel right: segment **Zone** (not "Full List")
3. **Start** — data is **appended** (not overwritten); duplicates by Place ID are skipped
4. **Pause / Resume** — queue is saved
5. Filters: chips, search, min rating — affect table and export
6. CSV / Copy (TSV) / Excel · Save/Load sessions · Check Websites
7. CRM: Options → Google Sheet webhook → Sheet button

## Limitations

- Website/phone usually only after clicking card — storage doesn't speed up collection
- Map area without «Rechercher dans cette zone» — Google limitation
- Don't set delay too low; Random 1.2–2.5s enabled against captcha

## Options / CRM

`chrome://extensions` → extension → **Details** → Extension options  
or Options link in popup.
