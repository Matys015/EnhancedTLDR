================================================================================
TLDR NEWSLETTER PROCESSOR
Dokumentacja użytkownika i instrukcja obsługi
================================================================================

Wersja dokumentacji: 1.1
Środowisko: Google Apps Script
Język raportów: polski
Język kodu i logów: angielski

--------------------------------------------------------------------------------
SPIS TREŚCI
--------------------------------------------------------------------------------

  1.  Co robi ta aplikacja
  2.  Jak działa — architektura
  3.  Wymagania przed instalacją
  4.  Instalacja krok po kroku
  5.  Weryfikacja po instalacji
  6.  Codzienne korzystanie
  7.  Struktura dokumentu wynikowego
  8.  Konfiguracja
  9.  Funkcje diagnostyczne
  10. Rozwiązywanie problemów
  11. Ograniczenia techniczne
  12. Bezpieczeństwo


================================================================================
1. CO ROBI TA APLIKACJA
================================================================================

TLDR Newsletter Processor to automatyczny asystent czytelnika, który każdego
ranka dostarcza gotowy do przeczytania raport z newsletterów technologicznych
rodziny TLDR.

Cykl dzienny wygląda następująco:

  - O godzinie 1:00 aplikacja przeszukuje Twoją skrzynkę Gmail w poszukiwaniu
    wczorajszych wydań newsletterów TLDR.

  - Wydobywa z nich listę artykułów wraz z metadanymi (tytuł, czas czytania,
    typ: artykuł / long-read / repozytorium GitHub / strona internetowa).

  - Dla każdego artykułu pobiera treść strony i wysyła ją do modelu językowego
    (LLM) przez API OpenRouter z prośbą o streszczenie w języku polskim.

  - Po przetworzeniu wszystkich artykułów kompiluje wyniki do estetycznie
    sformatowanego dokumentu Google Docs.

  - Zapisuje dokument na Twoim Google Drive w strukturze folderów
    TLDR / rok / miesiąc / dzień.

  - Wysyła Ci e-mail z linkiem do gotowego raportu.

Obsługiwane newslettery:

  TLDR          — ogólny przegląd technologii
  TLDR Dev      — programowanie i development
  TLDR DevOps   — DevOps, chmura, infrastruktura
  TLDR IT       — IT management, bezpieczeństwo
  TLDR AI       — sztuczna inteligencja


================================================================================
2. JAK DZIAŁA — ARCHITEKTURA
================================================================================

Google Apps Script narzuca twardy limit 6 minut na jedno wykonanie funkcji.
Przetworzenie 30–50 artykułów z wywołaniami AI zajmuje kilka godzin, więc
jedno ciągłe wykonanie jest niemożliwe.

Rozwiązaniem jest architektura potokowa: każde wywołanie przetwarza jeden
artykuł, a kolejne wywołanie jest wyzwalane triggerem czasowym co 5 minut.
Stan między wywołaniami (lista artykułów, wyniki, indeks bieżący) jest
przechowywany w Script Properties — trwałym magazynie Google Apps Script.

Schemat działania:

  startPipeline()
    Uruchamia się raz o 2:00. Sprawdza dzień tygodnia, zbiera artykuły
    ze wszystkich źródeł, zapisuje stan do Script Properties, tworzy
    trigger cykliczny.

  runNextStep()  [wywoływany co 5 minut przez trigger]
    Pobiera stan z Script Properties. Przetwarza jeden artykuł (scraping
    + wywołanie AI). Zapisuje wynik. Jeśli to ostatni artykuł — wywołuje
    finalizację.

  finalizePipeline()
    Tworzy dokument Google Docs, zapisuje na Drive, wysyła e-mail,
    czyści stan i usuwa trigger cykliczny.

Dni aktywne: wtorek, środa, czwartek, piątek, sobota.
(TLDR nie wysyła newsletterów w weekendy, więc przetwarzanie
w niedzielę i poniedziałek jest wyłączone.)

Mechanizmy bezpieczeństwa:

  - Blokada współbieżności (LockService) — jeśli poprzednie wywołanie
    runNextStep jeszcze trwa, nowe jest pomijane.

  - Ochrona przed duplikacją e-maila — flaga EMAIL_SENT zapobiega
    wielokrotnemu wysłaniu raportu nawet jeśli finalizacja zostanie
    wywołana kilkukrotnie.

  - Limit błędów z rzędu — jeśli 5 kolejnych artykułów zwróci błąd
    (np. API niedostępne), pipeline kończy się i wysyła raport częściowy.

  - Limit artykułów — maksymalnie 70 artykułów dziennie jako zabezpieczenie
    przed pętlą nieskończoną.


================================================================================
3. WYMAGANIA PRZED INSTALACJĄ
================================================================================

a) Konto Google
   Aktywne konto z dostępem do Gmail, Google Drive i Google Docs.
   Google Apps Script jest wbudowany w konto Google — nie wymaga instalacji.

b) Subskrypcja newsletterów TLDR
   Musisz być zapisany na co najmniej jeden newsletter z rodziny TLDR.
   Rejestracja jest bezpłatna: https://tldr.tech
   Aplikacja rozpoznaje newslettery po dokładnej nazwie nadawcy w polu From:.

c) Konto OpenRouter i klucz API
   OpenRouter to platforma agregująca wiele modeli AI.
   Rejestracja: https://openrouter.ai
   Po rejestracji przejdź do sekcji Keys i utwórz nowy klucz API.
   Klucz zaczyna się od sk-or-...
   Wiele modeli jest bezpłatnych (oznaczone sufiksem :free w nazwie).


================================================================================
4. INSTALACJA KROK PO KROKU
================================================================================

KROK 1 — Utwórz projekt Google Apps Script
-------------------------------------------

  1. Otwórz https://script.google.com
  2. Kliknij "Nowy projekt".
  3. Zmień nazwę projektu w górnej belce na np. "TLDR Newsletter Processor".
  4. Usuń domyślną zawartość edytora (function myFunction() {}).
  5. Wklej cały kod aplikacji z pliku tldr-processor.js.
  6. Zapisz projekt (Ctrl+S lub ikona dyskietki).


KROK 2 — Zapisz klucz API
--------------------------

Klucz API nie może być wpisany bezpośrednio w kod — to zagrożenie
bezpieczeństwa. Aplikacja używa zaszyfrowanego magazynu Script Properties.

  1. W lewym panelu edytora kliknij ikonę koła zębatego (Ustawienia projektu).
  2. Przewiń do sekcji "Właściwości skryptu".
  3. Kliknij "Dodaj właściwość".
  4. Wypełnij:
       Właściwość:  OPENROUTER_API_KEY
       Wartość:     sk-or-twój-klucz-api
  5. Kliknij "Zapisz właściwości skryptu".


KROK 3 — Nadaj uprawnienia
---------------------------

Przy pierwszym uruchomieniu Google poprosi o autoryzację. Aplikacja
potrzebuje dostępu do Gmail, Google Drive, Google Docs oraz zewnętrznych
URL (scraping artykułów i API OpenRouter).

Uprawnienia zostaną nadane automatycznie przy pierwszym wywołaniu
dowolnej funkcji (patrz Krok 4).

Jeśli pojawi się ostrzeżenie "Ta aplikacja nie jest zweryfikowana":
  → Kliknij "Ustawienia zaawansowane"
  → Kliknij "Przejdź do [nazwa projektu] (niebezpieczne)"
  → Kliknij "Zezwól"

To ostrzeżenie pojawia się dla wszystkich skryptów na koncie prywatnym.
Skrypt nie jest wysyłany do Google do weryfikacji, bo działa wyłącznie
na Twoich danych w obrębie Twojego konta.


KROK 4 — Przetestuj infrastrukturę (bez AI)
--------------------------------------------

  1. W edytorze wybierz z listy funkcji: testDriveOnly
  2. Kliknij "Uruchom" (przycisk ▶).
  3. Jeśli to pierwsze uruchomienie — pojawi się okno autoryzacji.
     Zaakceptuj wszystkie uprawnienia.
  4. Poczekaj około 30 sekund.
  5. Sprawdź logi: menu "Wyświetl" → "Logi" (lub Ctrl+Enter).

Oczekiwany wynik w logach:
  [1/4] Production folder... OK
  [2/4] Production doc...    OK
  [3/4] Debug doc...         OK
  [4/4] Test email...        OK
  testDriveOnly() COMPLETE.

Oczekiwany wynik zewnętrzny:
  - Na Google Drive pojawia się folder TLDR z testowymi dokumentami.
  - Na Gmail pojawia się e-mail "[INFRA TEST] Drive/Docs/Email".

Jeśli którykolwiek krok zwróci FAIL — patrz sekcja 10 (Rozwiązywanie
problemów).


KROK 5 — Przetestuj pełny pipeline z AI
-----------------------------------------

  1. Upewnij się, że na Twojej skrzynce Gmail jest co najmniej jedno
     wczorajsze wydanie newslettera TLDR.
  2. W edytorze wybierz funkcję: testSingleArticle
  3. Kliknij "Uruchom".
  4. Poczekaj 60–120 sekund (scraping + wywołanie AI).
  5. Sprawdź logi — szukaj linii "Done in Xs."

Oczekiwany wynik:
  - Logi zawierają streszczenie artykułu (pierwsze 300 znaków).
  - Na Drive w folderze TLDR/_debug/ pojawia się dokument testowy.
  - Na Gmail pojawia się e-mail "[DEBUG] Test modelu: ...".

Jeśli model AI nie zwróci odpowiedzi — sprawdź czy klucz API jest
poprawny i czy wybrany model obsługuje zapytania (patrz sekcja 10).


KROK 6 — Aktywuj codzienny trigger
------------------------------------

  1. W edytorze wybierz funkcję: setupDailyTrigger
  2. Kliknij "Uruchom".
  3. W logach powinno pojawić się:
       Daily trigger set: startPipeline() at 01:00.

Weryfikacja:
  Kliknij ikonę zegara (Triggery) w lewym panelu. Powinieneś zobaczyć:
    Funkcja:       startPipeline
    Źródło:        Oparty na czasie
    Typ:           Codziennie o godz. 1

Aplikacja jest teraz aktywna. Od tej chwili każdej nocy (wt–sb)
o 3:00 automatycznie przetworzy wczorajsze newslettery.


================================================================================
5. WERYFIKACJA PO INSTALACJI
================================================================================

Poniższa checklista potwierdza poprawną instalację:

  [ ] testDriveOnly() zakończył się bez błędów
  [ ] Na Gmail dotarł e-mail "[INFRA TEST] Drive/Docs/Email"
  [ ] Na Drive istnieje folder TLDR/
  [ ] testSingleArticle() zakończył się bez błędów
  [ ] Na Gmail dotarł e-mail "[DEBUG] Test modelu: ..."
  [ ] W folderze TLDR/_debug/ istnieje dokument testowy z treścią streszczenia
  [ ] setupDailyTrigger() wyświetlił komunikat o sukcesie
  [ ] W panelu Triggery widoczny jest wpis startPipeline / codziennie o 3:00


================================================================================
6. CODZIENNE KORZYSTANIE
================================================================================

Po poprawnej instalacji nie musisz nic robić. Pipeline działa automatycznie.

Harmonogram:

  ~3:00  startPipeline() zbiera artykuły z wczorajszych newsletterów
  ~3:05  Artykuł #1
  ~3:10  Artykuł #2
  ~3:15  Artykuł #3
  ...
  ~5:30  Ostatni artykuł → finalizacja → e-mail z linkiem

Korzystanie z raportu:

  1. Otwórz Gmail rano.
  2. Znajdź wiadomość z tematem "TLDR Digest gotowy - DD.MM.RRRR".
  3. E-mail zawiera statystyki:
       - Łączna liczba artykułów
       - Liczba wygenerowanych streszczeń
       - Liczba artykułów niedostępnych (paywall, 403, JavaScript)
       - Podział według źródeł
  4. Kliknij przycisk "Otwórz pełny raport w Google Docs".
  5. Dokument otwiera się w przeglądarce.

Gdzie szukać dokumentów na Drive:

  Google Drive (Mój dysk)
  └── TLDR/
      ├── 2025/
      │   ├── maj/
      │   │   ├── 19/
      │   │   │   └── TLDR Digest - 19.05.2025
      │   │   └── 20/
      │   │       └── TLDR Digest - 20.05.2025
      │   └── czerwiec/
      └── _debug/          ← dokumenty z testów, możesz ignorować

Każdy dzień dostaje własny folder. Żaden dokument nie nadpisuje poprzedniego.
Struktura rośnie automatycznie — nowy miesiąc i nowy rok tworzą się same.


================================================================================
7. STRUKTURA DOKUMENTU WYNIKOWEGO
================================================================================

Dokument Google Docs ma następującą strukturę:

  Dzienny Przegląd TLDR               [tytuł]
  DD.MM.RRRR                           [data]
  Artykułów: X | Streszczeń: Y | Niedostępnych: Z

  Spis treści
  • TLDR — N artykułów
  • TLDR AI — N artykułów

  ────────────────────────────────────────────────────────────

  TLDR                                 [nagłówek sekcji]

  01.  Tytuł artykułu                  [nagłówek artykułu, kolor #990000]
       5 min czytania  |  Źródło: TLDR
       Treść streszczenia w ciągłym tekście...
       Czytaj oryginalny artykuł       [klikalny link]

  02.  ...

  ────────────────────────────────────────────────────────────

  TLDR AI                              [nagłówek sekcji]
  ...

Typy artykułów i sposób ich opisania:

  Artykuł (≤ 20 min czytania)
    Pełne, wyczerpujące streszczenie: główna teza, kluczowe fakty,
    wnioski praktyczne. Napisane ciągłym tekstem w języku polskim.
    Etykieta meta: "N min czytania"

  Long-read (> 20 min czytania)
    Krótka zapowiedź (3–5 zdań): o czym jest artykuł, dla kogo,
    co czytelnik z niego wyniesie. Pełna treść wymaga kliknięcia linku.
    Etykieta meta: "Długi artykuł • N min czytania"

  GitHub Repo
    Opis projektu open source: cel, główne funkcje, technologie,
    dla kogo jest przeznaczony.
    Etykieta meta: "GitHub Repo"

  Website
    Opis serwisu lub narzędzia internetowego: czym jest, jakie oferuje
    funkcje, dla kogo jest przeznaczony i co go wyróżnia.
    Etykieta meta: "Website"

  Artykuł niedostępny (paywall / błąd 403 / wymaga JavaScript)
    Wyświetlany z symbolem ⚠ i komunikatem wyjaśniającym przyczynę.
    Link do oryginału jest zachowany.

Parser wykrywa typy artykułów na podstawie etykiet w treści newslettera:

  (N minute read)   → article lub long_read
  (GitHub Repo)     → github
  (Website)         → website


================================================================================
8. KONFIGURACJA
================================================================================

Wszystkie parametry konfiguracyjne znajdują się w obiekcie CONFIG
na początku pliku skryptu. Edytuj je bezpośrednio w edytorze
Google Apps Script.

Parametry główne:

  OPENROUTER_MODEL
    Identyfikator modelu AI używanego do streszczania.
    Domyślnie: 'openrouter/owl-alpha'
    Przykłady modeli bezpłatnych:
      'google/gemini-2.0-flash-exp:free'
      'meta-llama/llama-4-scout:free'
      'deepseek/deepseek-chat-v3-0324:free'
    Pełna lista modeli: https://openrouter.ai/models

  LONG_READ_THRESHOLD_MINUTES
    Próg w minutach oddzielający artykuł standardowy od long-reada.
    Domyślnie: 20
    Artykuły powyżej tej wartości otrzymują zapowiedź zamiast streszczenia.

  MAX_TEXT_LENGTH
    Maksymalna liczba znaków tekstu wysyłanego do modelu AI.
    Domyślnie: 40000 (około 6000–7000 słów)
    Zmniejsz do 25000 aby przyspieszyć i potencjalnie obniżyć koszty.
    Zwiększ do 60000 dla lepszej jakości streszczeń bardzo długich tekstów
    (wymaga modelu z dużym oknem kontekstu).

  MAX_TOTAL_ARTICLES
    Twardy limit artykułów przetwarzanych dziennie.
    Domyślnie: 70

  MAX_CONSECUTIVE_ERRORS
    Liczba błędów API z rzędu powodująca zakończenie pipeline
    z raportem częściowym.
    Domyślnie: 5

  STEP_TRIGGER_MINUTES
    Interwał w minutach między przetwarzaniem kolejnych artykułów.
    Domyślnie: 5
    Zmniejszenie przyspiesza pipeline, ale zwiększa ryzyko przekroczenia
    limitów API.

  DRIVE_ROOT_FOLDER
    Nazwa głównego folderu na Google Drive.
    Domyślnie: 'TLDR'

  ACTIVE_DAYS
    Tablica liczb reprezentujących aktywne dni tygodnia.
    0=niedziela, 1=poniedziałek, ..., 6=sobota
    Domyślnie: [2, 3, 4, 5, 6]  (wtorek–sobota)

Zmiana modelu AI:

  1. Otwórz skrypt w edytorze Google Apps Script.
  2. Znajdź linię:
       OPENROUTER_MODEL: 'openrouter/owl-alpha',
  3. Zamień wartość na identyfikator wybranego modelu.
  4. Zapisz skrypt.
  5. Uruchom testSingleArticle() aby zweryfikować działanie nowego modelu.

Dodawanie nowego newslettera TLDR:

  W tablicy SOURCES dodaj nowy obiekt:

    { id:       'tldr_security',
      label:    'TLDR Security',
      fromName: 'TLDR Security',
      query:    'from:dan@tldrnewsletter.com',
      color:    '#e74c3c' }

  WAŻNE: fromName musi dokładnie odpowiadać nazwie nadawcy widocznej
  w polu "Od:" w e-mailu (bez adresu e-mail, tylko nazwa).


================================================================================
9. FUNKCJE DIAGNOSTYCZNE
================================================================================

Wszystkie funkcje diagnostyczne są dostępne z poziomu edytora
Google Apps Script. Wybierz funkcję z listy i kliknij "Uruchom".

setupDailyTrigger()
  Tworzy lub odtwarza codzienny trigger uruchamiający pipeline o 3:00.
  Uruchom po każdej zmianie godziny startu lub po przypadkowym usunięciu
  triggera z panelu Triggery.

testDriveOnly()
  Testuje infrastrukturę (Drive, Docs, Gmail) bez użycia AI.
  Tworzy dwa dokumenty testowe i wysyła e-mail z linkami.
  Czas wykonania: ~30 sekund.
  Uruchom po każdej zmianie uprawnień lub po problemach z zapisem na Drive.

testSingleArticle()
  Pełny test end-to-end: szuka pierwszego dostępnego artykułu,
  streszcza go wybranym modelem AI, tworzy dokument w TLDR/_debug/
  i wysyła e-mail powiadomienie.
  Czas wykonania: 60–120 sekund.
  Uruchom po zmianie modelu AI lub po problemach z jakością streszczeń.
  Aby testować inny model, zmień stałą MODEL_OVERRIDE wewnątrz funkcji.

showArticles()
  Wyświetla w logach listę wszystkich artykułów znalezionych
  w wczorajszych newsletterach wraz z typem (article / long_read /
  github / website). Nie przetwarza żadnego artykułu.
  Czas wykonania: ~10 sekund.
  Uruchom gdy chcesz sprawdzić ile artykułów zostało wykrytych
  lub czy parser poprawnie rozpoznaje typy linków.

showState()
  Wyświetla aktualny stan pipeline: status, indeks bieżącego artykułu,
  liczbę wyników, stan flagi e-mail, aktywne triggery.
  Wyświetla też listę już przetworzonych artykułów ze statusem OK/ERR.
  Uruchom gdy pipeline jest aktywny i chcesz sprawdzić postęp.

emergencyReset()
  Natychmiastowe zatrzymanie pipeline i wyczyszczenie całego stanu.
  Usuwa trigger cykliczny runNextStep i kasuje wszystkie właściwości
  przechowujące stan.
  UWAGA: Po resecie raport za bieżący dzień nie zostanie wysłany.
  Po resecie możesz ręcznie uruchomić startPipeline() aby zacząć od nowa.


================================================================================
10. ROZWIĄZYWANIE PROBLEMÓW
================================================================================

PROBLEM: Brak e-maila z raportem rano
---------------------------------------

Sprawdź 1: Czy trigger istnieje?
  Kliknij ikonę zegara (Triggery) w lewym panelu edytora.
  Jeśli brak wpisu startPipeline → uruchom setupDailyTrigger().

Sprawdź 2: Czy pipeline utknął?
  Uruchom showState().
  Jeśli status = 'running' i minęło kilka godzin od startu →
  uruchom emergencyReset(), potem startPipeline().

Sprawdź 3: Czy są newslettery na skrzynce?
  Uruchom showArticles().
  Jeśli wynik to "Total: 0" → sprawdź czy:
    - jesteś zapisany na newslettery TLDR
    - wczorajsze wydanie dotarło (sprawdź zakładkę Spam)
    - fromName w CONFIG.SOURCES odpowiada dokładnie nazwie nadawcy

Sprawdź 4: Logi triggerów
  W panelu Triggery kliknij ⋮ przy wpisie startPipeline →
  "Wyświetl wykonania". Szukaj błędów w logach z poprzedniego dnia.


PROBLEM: Artykuły oznaczone jako niedostępne (⚠)
--------------------------------------------------

Przyczyna: Artykuł jest za paywallem, serwer zwraca błąd 403
lub strona wymaga JavaScript do renderowania treści.

To zachowanie normalne i oczekiwane. Aplikacja oznacza taki artykuł
komunikatem i zachowuje link do oryginału. Możesz kliknąć link
i przeczytać artykuł samodzielnie.

Typowy odsetek niedostępnych artykułów: 10–30%.


PROBLEM: Pipeline kończy się wcześniej z komunikatem o błędach
---------------------------------------------------------------

Przyczyna: 5 artykułów z rzędu zwróciło błąd API.

  1. Sprawdź czy klucz API jest poprawny (Script Properties).
  2. Sprawdź status API: https://status.openrouter.ai
  3. Sprawdź czy wybrany model jest aktualnie dostępny na OpenRouter.
  4. Jeśli używasz modelu bezpłatnego, mógł zostać wycofany —
     zmień model w CONFIG.OPENROUTER_MODEL.


PROBLEM: testSingleArticle() — "No accessible article found"
-------------------------------------------------------------

Przyczyna: Brak e-maili TLDR z wczoraj LUB wszystkie artykuły
z wczorajszego newslettera są za paywallem.

  1. Uruchom showArticles() — jeśli wynik to 0, problem leży w Gmail.
  2. Sprawdź czy na skrzynce jest wczorajszy e-mail od TLDR.
  3. Sprawdź zakładkę Spam.


PROBLEM: Dokument nie zawiera treści (same błędy ⚠)
----------------------------------------------------

Przyczyna: Model AI nie odpowiada lub klucz API wygasł.

  1. Sprawdź klucz API w Script Properties.
  2. Zaloguj się na openrouter.ai i sprawdź status klucza.
  3. Uruchom testSingleArticle() i przejrzyj logi.
  4. Spróbuj zmienić model na inny bezpłatny.


PROBLEM: Czcionka Ubuntu nie wyświetla się w dokumencie
-------------------------------------------------------

Google Docs musi mieć czcionkę dodaną do konta użytkownika.

  1. Otwórz dowolny dokument Google Docs.
  2. Format → Tekst → Więcej czcionek.
  3. Wyszukaj "Ubuntu" i dodaj ją.

Skrypt zapisze czcionkę poprawnie — problem jest tylko po stronie
wyświetlania na koncie bez tej czcionki.

Alternatywa: zmień 'Ubuntu' na 'Roboto' lub 'Open Sans' w kodzie
(szukaj wszystkich wystąpień setFontFamily('Ubuntu')).


PROBLEM: Trigger zniknął z panelu
-----------------------------------

Google Apps Script może usunąć triggery w przypadku błędu autoryzacji
lub po długim okresie nieużywania.

Rozwiązanie: uruchom setupDailyTrigger().


================================================================================
11. OGRANICZENIA TECHNICZNE
================================================================================

  Limit czasu jednej funkcji    6 minut (Google Apps Script)
  Limit artykułów dziennie      70 (konfigurowalny)
  Max tekstu do AI              40 000 znaków (~6 000–7 000 słów)
  Interwał między artykułami    5 minut
  Max błędów z rzędu            5 przed raportem częściowym
  Max e-maili dziennie          100 (limit Google Apps Script)

Artykuły przetwarzane są TYLKO z poprzedniego dnia. Nie ma możliwości
przetworzenia artykułów starszych niż jeden dzień bez modyfikacji kodu.

Aplikacja działa wyłącznie gdy konto Google jest aktywne. Długi okres
nieaktywności konta może spowodować wygaśnięcie uprawnień i usunięcie
triggerów.


================================================================================
12. BEZPIECZEŃSTWO
================================================================================

Klucz API
  Przechowywany w zaszyfrowanym magazynie Script Properties.
  Nigdy nie pojawia się w kodzie ani w logach.
  Dostęp do Script Properties ma tylko właściciel projektu.

Zakres działania
  Aplikacja działa wyłącznie w obrębie Twojego konta Google.
  Nie wysyła żadnych danych do zewnętrznych serwerów poza:
    - OpenRouter API (treść artykułów do streszczenia)
    - URL artykułów (pobieranie treści stron)

Ryzyko prompt injection
  Złośliwy tekst w artykule mógłby próbować manipulować zachowaniem
  modelu AI. W praktyce ryzyko jest minimalne, ponieważ odpowiedź
  modelu jest zwykłym stringiem tekstowym — nie jest interpretowana
  jako kod ani nie ma dostępu do żadnych funkcji aplikacji.
  Najgorszy możliwy efekt to dziwne lub bezużyteczne streszczenie.

Polityka prywatności OpenRouter
  Treść artykułów jest wysyłana do OpenRouter i przetwarzana zgodnie
  z ich polityką prywatności: https://openrouter.ai/privacy
  Nie wysyłaj przez tę aplikację treści poufnych ani osobistych.


================================================================================
SZYBKA ŚCIĄGAWKA — PIERWSZE URUCHOMIENIE
================================================================================

  1. script.google.com → Nowy projekt → wklej kod → Zapisz
  2. Ustawienia projektu → Właściwości skryptu → OPENROUTER_API_KEY = sk-or-...
  3. Uruchom testDriveOnly()     → sprawdź logi i skrzynkę Gmail
  4. Uruchom testSingleArticle() → sprawdź logi i folder TLDR/_debug/ na Drive
  5. Uruchom setupDailyTrigger() → sprawdź panel Triggery

Gotowe. Raport będzie czekał jutro rano.

================================================================================
SZYBKA ŚCIĄGAWKA — CODZIENNA OBSŁUGA
================================================================================

  Chcę sprawdzić postęp pipeline:    showState()
  Chcę zobaczyć ile jest artykułów:  showArticles()
  Pipeline utknął / coś nie działa:  emergencyReset() → startPipeline()
  Trigger zniknął:                   setupDailyTrigger()
  Testuję nowy model AI:             zmień MODEL_OVERRIDE w testSingleArticle()
                                     → uruchom testSingleArticle()

================================================================================