# Maps Lead Scraper 2.1

Полуручной Chrome-скрапер Google Maps: живая таблица как Instant Data Scraper, фильтры, append/dedupe, пауза, сессии, Excel/TSV, проверка сайтов, выгрузка в Sheet/Notion/Airtable.

## Установка

1. `chrome://extensions` → Developer mode → **Load unpacked**
2. Выбери папку `map-search` (где `manifest.json`)
3. Открой Maps → F5 после обновления расширения

## Как пользоваться

1. Зум на участок → **«Rechercher dans cette zone»**
2. На панели справа: сегмент **Зона** (не «Весь список»)
3. **Старт** — данные **дописываются** (не затирают таблицу); дубли по Place ID пропускаются
4. **Пауза / Продолжить** — очередь сохраняется
5. Фильтры: чипы, поиск, мин. рейтинг — влияют на таблицу и экспорт
6. CSV / Копировать (TSV) / Excel · Save/Load сессий · Проверить сайты
7. CRM: Options → ключи → кнопки Sheet / Notion / Airtable

## Ограничения

- Сайт/телефон почти всегда только после клика по карточке — storage не ускоряет сбор
- Зона карты без «Rechercher dans cette zone» — ограничение Google
- Не ставь задержку слишком низкой; включён Random 1.2–2.5s против капчи

## Options / CRM

`chrome://extensions` → расширение → **Подробнее** → Параметры расширения  
или ссылка Options в попапе.
