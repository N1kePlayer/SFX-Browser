# SFX Browser для DaVinci Resolve

Порт SFX Browser из After Effects / Premiere (папка `SFX_Browser/`) для DaVinci Resolve,
с переработанным интерфейсом. Это Workflow Integration плагин: он открывается из меню
**Workspace → Workflow Integrations → SFX Browser**.

> **Нужна DaVinci Resolve Studio.** Workflow Integration плагины в бесплатной версии
> Resolve не загружаются. Поддерживаются macOS и Windows (под Linux Resolve такие плагины не грузит).

## Что умеет

- Ваши папки со звуками в исходной структуре, без автосортировки. Раскрытые папки запоминаются.
- **Поиск по всем папкам сразу** (рекурсивно, слова в любом порядке), с путём к каждому найденному звуку.
- Избранное (звёздочка или клавиша `F`) — отдельная вкладка **Favorites**.
- Скрытие звуков и папок (файлы на диске не трогаются), восстановление через кнопку с глазом.
- Превью с волновой формой: клик по волне — воспроизведение с этого места, бегущий плейхед.
  Громкость превью и автоплей при выборе.
- Свои декодеры WAV (PCM 8/16/24/32, float, A-law, µ-law) и AIFF/AIFF-C, поэтому превью работает
  без ffmpeg. MP3, FLAC, OGG, M4A и AAC декодирует движок Chromium.
- Информация о файле: формат, длительность, частота, каналы, битность, размер, путь
  (кнопки «Показать в папке» и «Скопировать путь»), заметки к каждому звуку.
- **Add to Timeline** ставит звук в позицию плейхеда на самую нижнюю аудиодорожку, которая свободна
  на всю длину звука. Заблокированные дорожки пропускаются. Если свободной нет, плагин создаёт новую
  дорожку (mono или stereo, по файлу). Клипы складываются в бин **SFX Browser** в Media Pool,
  повторно один и тот же файл не импортируется.
- **Drag & drop**: звук можно перетащить прямо на таймлайн или в Media Pool Resolve.
  Это обычное перетаскивание файла из системы, поэтому работает надёжно.
- Двойной клик только проигрывает звук. На таймлайн звук попадает только по кнопке ADD
  (как и в версии для Adobe).
- Индикатор подключения к Resolve внизу: проект и активный таймлайн.

### Горячие клавиши

| Клавиша | Действие |
|---|---|
| `↑` / `↓` | следующий / предыдущий звук или папка |
| `→` / `←` | раскрыть / свернуть папку, `←` на звуке переходит к родительской папке |
| `Space` | play / stop (на папке раскрывает её) |
| `F` | добавить в избранное или убрать из него |
| `/` | перейти в поиск, `↓` или `Enter` из поиска переходит к результатам |
| `Esc` | очистить поиск, закрыть меню |

## Установка

1. Скопируйте папку `SFX_Browser_Resolve` к себе.
2. Запустите установщик:
   - **macOS:** двойной клик по `install_mac.command` (попросит пароль администратора).
   - **Windows:** правый клик по `install_windows.bat` → **Запуск от имени администратора**.
3. Перезапустите Resolve и откройте **Workspace → Workflow Integrations → SFX Browser**.

Установщик кладёт плагин сюда:

- macOS: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/SFX Browser/`
- Windows: `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\SFX Browser\`

### WorkflowIntegration.node

Для связи с Resolve нужен модуль Blackmagic `WorkflowIntegration.node`. Его нет в репозитории:
это бинарник Blackmagic, и он должен совпадать с вашей версией Resolve. Resolve Studio сам ставит
его в папку для разработчиков:

- macOS: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/`
- Windows: `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\`

Установщик копирует его оттуда автоматически. Если модуля нет рядом с плагином, плагин сам ищет его
в этой папке. Если внизу горит красный индикатор **Resolve not connected**, скопируйте файл в папку плагина вручную.

## Где хранятся данные

Папки, избранное, скрытые элементы, заметки и настройки лежат в одном JSON-файле:

- macOS: `~/Library/Application Support/SFX Browser for Resolve/state.json`
- Windows: `%APPDATA%\SFX Browser for Resolve\state.json`

## Структура

```
manifest.xml        описание плагина для Resolve
main.js             Electron main: окно, IPC, файловая система, drag & drop
preload.js          безопасный мост renderer ↔ main (contextIsolation + sandbox)
lib/resolve.js      Resolve API: импорт в бин, поиск свободной дорожки, вставка по плейхеду
lib/library.js      чтение папок, рекурсивный поиск, хранилище состояния
index.html, css/    интерфейс
js/audio.js         декодеры WAV/AIFF, пики волны, плеер превью
js/app.js           логика интерфейса
test/               тесты (node --test)
```

Проверка без Resolve: `npm test` (13 тестов: декодеры, файловая часть и логика вставки на макете Resolve API).
