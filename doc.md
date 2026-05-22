================================================================================
TLDR NEWSLETTER PROCESSOR
Dokumentacja użytkownika i instrukcja obsługi
================================================================================

Wersja dokumentacji: 1.2
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

  O godzinie 00:00 aplikacja przeszukuje Twoją skrzynkę Gmail w poszukiwaniu
  wczorajszych wydań newsletterów TLDR.

  Wydobywa z nich listę artykułów wraz z metadanymi (tytuł, czas czytania,
  typ) oraz krótkim opisem inline, który TLDR umieszcza pod każdym linkiem.

  Usuwa duplikaty tematyczne — artykuły opisujące to samo wydarzenie,
  pojawiające się w kilku newsletterach jednocześnie.

  Dla każdego artykułu próbuje pobrać treść strony. Jeśli się uda,
  wysyła ją do modelu językowego (LLM) przez API OpenRouter z prośbą
  o streszczenie w języku polskim.

  Jeśli strona jest niedostępna (paywall, blokada, wymaga JavaScript),
  aplikacja tłumaczy na polski krótki opis artykułu z samego maila TLDR.
  Dokument wyraźnie oznacza takie wpisy jako pochodzące ze skrótu newslettera.

  Po przetworzeniu wszystkich artykułów kompiluje wyniki do estetycznie
  sformatowanego dokumentu Google Docs.

  Zapisuje dokument na Twoim Google Drive w strukturze folderów
  TLDR / rok / miesiąc / dzień.

  Wysyła Ci e-mail z linkiem do gotowego raportu.

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
Przetworzenie wielu artykułów z wywołaniami AI może zajmować kilka godzin,
więc jedno ciągłe wykonanie jest niemożliwe.

Rozwiązaniem jest architektura potokowa: każde wywołanie przetwarza jeden
artykuł, a kolejne wywołanie jest wyzwalane triggerem czasowym co 5 minut.
Stan między wywołaniami jest przechowywany w Script Properties.

Schemat działania:

  startPipeline()
    Uruchamia się raz o 00:00. Sprawdza dzień tygodnia, zbiera artykuły
    ze wszystkich źródeł, usuwa duplikaty, zapisuje stan do Script
    Properties, tworzy trigger cykliczny co 5 minut.

  runNextStep()  [wywoływany co 5 minut przez trigger]
    Pobiera bieżący artykuł z kolejki. Próbuje scrapu strony. Jeśli
    scraping się powiedzie — wysyła tekst do AI. Jeśli nie — sprawdza
    czy jest snippet z maila i jeśli tak, wysyła go do tłumaczenia.
    Zapisuje wynik. Jeśli to ostatni artykuł — wywołuje finalizację.

  finalizePipeline()
    Tworzy dokument Google Docs, zapisuje na Drive, wysyła e-mail,
    czyści stan i usuwa trigger cykliczny. Reset następuje TYLKO
    po pomyślnym wysłaniu e-maila — błąd podczas tworzenia dokumentu
    pozwala na ponowne wywołanie finalizacji przez następny trigger.

Dni aktywne: wtorek, środa, czwartek, piątek, sobota.
(TLDR nie wysyła newsletterów w weekendy, więc przetwarzanie
w niedzielę i poniedziałek jest wyłączone.)

WAŻNE: Strefa czasowa triggera pochodzi z ustawień projektu Apps Script,
nie z konta Google. Przed uruchomieniem sprawdź i ustaw właściwą strefę
w Ustawieniach projektu → Strefa czasowa.


Mechanizm fallback dla niedostępnych stron:

  Parser podczas wczytywania maila wydobywa nie tylko linki artykułów,
  ale też krótkie opisy (snippety) zamieszczone przez TLDR pod każdym
  linkiem. Gdy scraping strony zawiedzie, ten snippet jest wysyłany do
  modelu AI z prośbą o tłumaczenie na polski — zamiast zwracać błąd.
  Decyzja, który prompt wysłać (streszczenie vs. tłumaczenie), zapada
  po zakończeniu scrapingu — dla każdego artykułu wysyłane jest zawsze
  dokładnie jedno zapytanie do LLM.


Mechanizm retry:

  Jeśli model AI zwróci błąd tymczasowy (HTTP 408, 429, 500, 502, 503,
  504), artykuł jest odkładany na koniec kolejki z opóźnieniem. Kolejna
  próba nastąpi po upływie obliczonego czasu oczekiwania. Na ostatniej
  próbie pipeline przełącza się na model zapasowy (OPENROUTER_MODEL_BACKUP).
  Po wyczerpaniu wszystkich prób artykuł jest oznaczony błędem i pipeline
  kontynuuje kolejny artykuł.


Deduplikacja tematyczna:

  Artykuły ze wszystkich newsletterów są porównywane tytułami.
  Algorytm normalizuje tokeny (stemming, synonimy, stop words),
  a następnie oblicza współczynnik Jaccarda i containment ratio.
  Artykuły uznane za tematycznie identyczne są pomijane — do raportu
  trafia tylko pierwsze znalezione wystąpienie.


Mechanizmy bezpieczeństwa:

  Blokada współbieżności (LockService) — jeśli poprzednie wywołanie
  runNextStep jeszcze trwa, nowe jest pomijane.

  Ochrona przed duplikacją e-maila — flaga EMAIL_SENT zapobiega
  wielokrotnemu wysłaniu raportu nawet jeśli finalizacja zostanie
  wywołana wielokrotnie.

  Limit błędów z rzędu — jeśli 5 kolejnych artykułów zwróci błąd,
  pipeline kończy się i wysyła raport częściowy.

  Aktualizacja totalExpected po retry — gdy artykuł jest kolejkowany
  do ponownej próby, licznik oczekiwanych wyników jest aktualizowany,
  by finalizacja nie nastąpiła przedwcześnie.


================================================================================
3. WYMAGANIA PRZED INSTALACJĄ
================================================================================

a) Konto Google
   Aktywne konto z dostępem do Gmail, Google Drive i Google Docs.
   Google Apps Script jest wbudowany w konto Google — nie wymaga instalacji.

b) Subskrypcja newsletterów TLDR
   Musisz być zapisany na co najmniej jeden newsletter z rodziny TLDR.
   Rejestracja jest bezpłatna: https://tldr.tech
   Aplikacja rozpoznaje newslettery po dokładnej nazwie nadawcy w polu Od:.

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


KROK 2 — Ustaw strefę czasową projektu
----------------------------------------

  1. W lewym panelu kliknij ikonę koła zębatego (Ustawienia projektu).
  2. W sekcji "Ogólne" znajdź pole "Strefa czasowa".
  3. Ustaw na "Europe/Warsaw" (lub właściwą dla Twojej lokalizacji).
  4. Zapisz ustawienia.

  WAŻNE: Ta strefa czasowa decyduje o tym, o której godzinie odpali
  trigger. Jeśli pozostawisz domyślną (np. America/New_York), pipeline
  uruchomi się o innej porze niż oczekujesz.


KROK 3 — Zapisz klucz API
--------------------------

  Klucz API nie może być wpisany bezpośrednio w kod. Aplikacja używa
  zaszyfrowanego magazynu Script Properties.

  1. W lewym panelu edytora kliknij ikonę koła zębatego (Ustawienia projektu).
  2. Przewiń do sekcji "Właściwości skryptu".
  3. Kliknij "Dodaj właściwość".
  4. Wypełnij:
       Właściwość:  OPENROUTER_API_KEY
       Wartość:     sk-or-twój-klucz-api
  5. Kliknij "Zapisz właściwości skryptu".


KROK 4 — Nadaj uprawnienia
---------------------------

  Przy pierwszym uruchomieniu Google poprosi o autoryzację. Aplikacja
  potrzebuje dostępu do Gmail, Google Drive, Google Docs oraz zewnętrznych
  URL (scraping artykułów i API OpenRouter).

  Uprawnienia zostaną nadane automatycznie przy pierwszym uruchomieniu
  dowolnej funkcji (patrz Krok 5).

  Jeśli pojawi się ostrzeżenie "Ta aplikacja nie jest zweryfikowana":
    → Kliknij "Ustawienia zaawansowane"
    → Kliknij "Przejdź do [nazwa projektu] (niebezpieczne)"
    → Kliknij "Zezwól"


KROK 5 — Przetestuj infrastrukturę (bez AI)
--------------------------------------------

  1. W edytorze wybierz z listy funkcji: testDriveOnly
  2. Kliknij "Uruchom" (przycisk ▶).
  3. Jeśli to pierwsze uruchomienie — zaakceptuj uprawnienia.
  4. Poczekaj około 30 sekund.
  5. Sprawdź logi: Ctrl+Enter lub menu "Wyświetl" → "Logi".

  Oczekiwany wynik w logach:
    [1/4] Production folder... OK
    [2/4] Production doc...    OK
    [3/4] Debug doc...         OK
    [4/4] Test email...        OK
    testDriveOnly() COMPLETE.

  Oczekiwany wynik zewnętrzny:
    - Na Google Drive pojawia się folder TLDR/ z testowymi dokumentami.
    - Na Gmail pojawia się e-mail "[INFRA TEST] Drive/Docs/Email".

  Jeśli którykolwiek krok zwróci FAIL — patrz sekcja 10.


KROK 6 — Przetestuj pełny pipeline z AI
-----------------------------------------

  1. Upewnij się, że na Twojej skrzynce Gmail jest co najmniej jedno
     wczorajsze wydanie newslettera TLDR.
  2. W edytorze wybierz funkcję: testSingleArticle
  3. Kliknij "Uruchom".
  4. Poczekaj 60–120 sekund (scraping + wywołanie AI).
  5. Sprawdź logi — szukaj linii "Done in Xs."

  Oczekiwany wynik:
    - Logi zawierają streszczenie artykułu (pierwsze 120 znaków).
    - Na Drive w folderze TLDR/_debug/ pojawia się dokument testowy.
    - Na Gmail pojawia się e-mail "[DEBUG] Test modelu: ...".
    - Dokument zawiera wyniki dla modelu głównego i zapasowego.


KROK 7 — Aktywuj codzienny trigger
------------------------------------

  1. W edytorze wybierz funkcję: setupDailyTrigger
  2. Kliknij "Uruchom".
  3. W logach powinno pojawić się:
       Daily trigger set: startPipeline() at 00:00.

  Weryfikacja w panelu Triggery (ikona zegara w lewym panelu):
    Funkcja:    startPipeline
    Źródło:     Oparty na czasie
    Typ:        Codziennie, godzina 0

  WAŻNE: Jeśli wcześniej uruchamiałeś setupDailyTrigger() z inną
  godziną, stary trigger mógł pozostać aktywny. Funkcja usuwa poprzedni
  trigger przed utworzeniem nowego, ale sprawdź w panelu Triggery
  czy widnieje dokładnie jeden wpis startPipeline.


================================================================================
5. WERYFIKACJA PO INSTALACJI
================================================================================

  [ ] Strefa czasowa projektu ustawiona poprawnie (Ustawienia projektu)
  [ ] Klucz OPENROUTER_API_KEY istnieje w Właściwościach skryptu
  [ ] testDriveOnly() zakończył się bez błędów
  [ ] Na Gmail dotarł e-mail "[INFRA TEST] Drive/Docs/Email"
  [ ] Na Drive istnieje folder TLDR/
  [ ] testSingleArticle() zakończył się bez błędów
  [ ] Na Gmail dotarł e-mail "[DEBUG] Test modelu: ..."
  [ ] W folderze TLDR/_debug/ istnieje dokument testowy z treścią
  [ ] setupDailyTrigger() wyświetlił komunikat o sukcesie
  [ ] W panelu Triggery widoczny jest dokładnie jeden wpis startPipeline


================================================================================
6. CODZIENNE KORZYSTANIE
================================================================================

Po poprawnej instalacji nie musisz nic robić. Pipeline działa automatycznie.

Przykładowy harmonogram (przy 4 artykułach, trigger co 5 minut):

  00:00  startPipeline() — zbieranie i deduplikacja artykułów
  00:05  Artykuł #1 — scraping + AI
  00:10  Artykuł #2 — scraping + AI
  00:15  Artykuł #3 — scraping + AI (lub tłumaczenie snippetu)
  00:20  Artykuł #4 — scraping + AI
  ~00:21 Finalizacja — tworzenie dokumentu + e-mail

Korzystanie z raportu:

  1. Otwórz Gmail rano.
  2. Znajdź wiadomość "TLDR Digest gotowy - DD.MM.RRRR".
  3. E-mail zawiera:
       - Łączną liczbę artykułów i streszczeń
       - Liczbę artykułów niedostępnych
       - Liczbę usuniętych duplikatów tematycznych
       - Podział według źródeł
  4. Kliknij "Otwórz pełny raport w Google Docs".

Struktura folderów na Drive:

  Google Drive (Mój dysk)
  └── TLDR/
      ├── 2025/
      │   ├── maj/
      │   │   └── 22/
      │   │       └── TLDR Digest - 22.05.2025
      │   └── czerwiec/
      │       └── 01/
      │           └── TLDR Digest - 01.06.2025
      └── _debug/
          └── 2025-05-22 16:42/
              └── [DEBUG] TLDR Test - ...


================================================================================
7. STRUKTURA DOKUMENTU WYNIKOWEGO
================================================================================

  Dzienny Przegląd TLDR                          [tytuł]
  DD.MM.RRRR                                      [data]
  Artykułów: X  |  Streszczeń: Y  |  Niedostępnych: Z  |  Duplikatów usuniętych: N

  Spis treści
  • TLDR — N artykułów
  • TLDR AI — N artykułów
  ...

  ────────────────────────────────────────────────────────────

  TLDR                                            [nagłówek sekcji]

  01.  Tytuł artykułu
       5 min czytania  |  Źródło: TLDR
       Treść streszczenia w ciągłym tekście...
       Czytaj oryginalny artykuł

  02.  Tytuł artykułu niedostępnego
       8 min czytania  |  Źródło: TLDR  |  Opis: skrót z newslettera TLDR (strona niedostępna)
       Strona niedostępna — poniższy opis pochodzi ze skrótu newslettera TLDR
       (tłumaczenie automatyczne):
       Przetłumaczony tekst z newslettera...
       Czytaj oryginalny artykuł

  03.  Tytuł artykułu całkowicie niedostępnego
       [!] Page content unavailable (blocked, paywalled, or requires JavaScript).
       Czytaj oryginalny artykuł

Typy artykułów i sposób ich opisania:

  Artykuł (≤ 20 min)
    Pełne streszczenie: główna teza, kluczowe fakty, wnioski praktyczne.
    Ciągły tekst po polsku, 3–6 akapitów.

  Long-read (> 20 min)
    Krótka zapowiedź (3–5 zdań): o czym artykuł, dla kogo, co czytelnik wyniesie.
    Etykieta: "Długi artykuł • N min czytania"

  GitHub Repo
    Cel projektu, główne funkcje, technologie, dla kogo przeznaczony.
    Etykieta: "GitHub Repo"

  Website
    Czym jest serwis, co oferuje, dla kogo, co go wyróżnia.
    Etykieta: "Website"

  Artykuł ze snippetem (strona niedostępna, snippet dostępny)
    Przetłumaczony na polski opis z maila TLDR.
    Etykieta meta zawiera adnotację "Opis: skrót z newslettera TLDR".
    Nad treścią widnieje kursywą: "Strona niedostępna — poniższy opis
    pochodzi ze skrótu newslettera TLDR (tłumaczenie automatyczne):"

  Artykuł całkowicie niedostępny (brak snippetu lub błąd tłumaczenia)
    Komunikat błędu oznaczony [!].
    Link do oryginału zachowany.


================================================================================
8. KONFIGURACJA
================================================================================

Wszystkie parametry konfiguracyjne znajdują się w obiekcie CONFIG
na początku pliku skryptu.

  OPENROUTER_MODEL
    Identyfikator modelu AI używanego do streszczania.
    Domyślnie: 'openrouter/owl-alpha'
    Przykłady modeli bezpłatnych:
      'google/gemini-2.0-flash-exp:free'
      'meta-llama/llama-4-scout:free'
      'deepseek/deepseek-chat-v3-0324:free'
    Pełna lista: https://openrouter.ai/models

  OPENROUTER_MODEL_BACKUP
    Model używany na ostatniej próbie gdy model główny zawodzi.
    Domyślnie: 'z-ai/glm-4.5-air:free'
    Uwaga: niektóre modele zwracają pole "reasoning" (tok myślenia)
    zajmujące dodatkowe tokeny. Kod automatycznie dodaje 800 tokenów
    do limitu gdy używany jest model zapasowy.

  LONG_READ_THRESHOLD_MINUTES
    Próg w minutach oddzielający artykuł standardowy od long-reada.
    Domyślnie: 20

  MAX_TEXT_LENGTH
    Maksymalna liczba znaków tekstu wysyłanego do modelu AI.
    Domyślnie: 40000 (~6000–7000 słów)

  MAX_TOTAL_ARTICLES
    Twardy limit artykułów przetwarzanych dziennie (po deduplikacji).
    Domyślnie: 4

  MAX_AI_ATTEMPTS
    Maksymalna liczba prób wywołania AI na artykuł.
    Domyślnie: 3 (próby 1–2: model główny, próba 3: model zapasowy)

  MAX_CONSECUTIVE_ERRORS
    Liczba błędów z rzędu powodująca zakończenie pipeline z raportem
    częściowym.
    Domyślnie: 5

  STEP_TRIGGER_MINUTES
    Interwał w minutach między przetwarzaniem kolejnych artykułów.
    Domyślnie: 5

  DRIVE_ROOT_FOLDER
    Nazwa głównego folderu na Google Drive.
    Domyślnie: 'TLDR'

  ACTIVE_DAYS
    Aktywne dni tygodnia. 0=niedziela, 1=poniedziałek, ..., 6=sobota.
    Domyślnie: [2, 3, 4, 5, 6]

Zmiana modelu AI:

  1. Znajdź linię OPENROUTER_MODEL: 'openrouter/owl-alpha',
  2. Zamień wartość na identyfikator wybranego modelu.
  3. Zapisz skrypt.
  4. Uruchom testSingleArticle() aby zweryfikować nowy model.

Dodawanie nowego newslettera TLDR:

  W tablicy SOURCES dodaj nowy obiekt:

    { id:       'tldr_security',
      label:    'TLDR Security',
      fromName: 'TLDR Security',
      query:    'from:dan@tldrnewsletter.com',
      color:    '#e74c3c' }

  WAŻNE: fromName musi dokładnie odpowiadać nazwie nadawcy widocznej
  w polu "Od:" w e-mailu (tylko nazwa, bez adresu e-mail).


================================================================================
9. FUNKCJE DIAGNOSTYCZNE
================================================================================

setupDailyTrigger()
  Tworzy lub odtwarza codzienny trigger startPipeline() o 00:00.
  Usuwa stary trigger przed utworzeniem nowego.
  Uruchom po każdej zmianie godziny startu lub gdy trigger zniknął
  z panelu.

testDriveOnly()
  Testuje infrastrukturę (Drive, Docs, Gmail) bez użycia AI.
  Tworzy dwa dokumenty testowe i wysyła e-mail z linkami.
  Czas: ~30 sekund.
  Uruchom przy pierwszej instalacji i po każdej zmianie uprawnień.

testSingleArticle()
  Pełny test end-to-end: szuka dostępnych artykułów, przetwarza jeden
  modelem głównym i jeden modelem zapasowym, tworzy dokument debug
  w TLDR/_debug/ i wysyła e-mail z podsumowaniem.
  Czas: 60–180 sekund.
  Uruchom po zmianie modelu AI lub przy problemach z jakością streszczeń.

showArticles()
  Wyświetla w logach listę wszystkich artykułów znalezionych we
  wczorajszych newsletterach (po deduplikacji) z typem i snippetem.
  Czas: ~10 sekund.
  Uruchom gdy chcesz sprawdzić co zostało wykryte bez uruchamiania AI.

showState()
  Wyświetla aktualny stan pipeline:
    - status (idle / running)
    - postęp (indeks / łączna liczba)
    - liczba wyników
    - flaga e-mail
    - aktywne triggery
    - lista artykułów oczekujących na retry z czasem następnej próby
    - lista przetworzonych artykułów ze statusem OK / ERR
  Uruchom gdy pipeline jest aktywny i chcesz sprawdzić postęp.

emergencyReset()
  Natychmiastowe zatrzymanie pipeline i wyczyszczenie całego stanu.
  Usuwa trigger cykliczny runNextStep i kasuje wszystkie właściwości.
  UWAGA: Po resecie raport za bieżący dzień nie zostanie wysłany.
  Użyj tylko gdy showState() wykazuje problemy nie do naprawienia.


================================================================================
10. ROZWIĄZYWANIE PROBLEMÓW
================================================================================

PROBLEM: Brak e-maila z raportem rano
---------------------------------------

Sprawdź 1 — Czy trigger istnieje?
  Kliknij ikonę zegara (Triggery) w lewym panelu.
  Brak wpisu startPipeline → uruchom setupDailyTrigger().

Sprawdź 2 — Czy pipeline utknął?
  Uruchom showState().
  Status = 'running' i minęło kilka godzin →
  uruchom emergencyReset(), potem startPipeline().

Sprawdź 3 — Czy są newslettery na skrzynce?
  Uruchom showArticles().
  Wynik "Raw: 0" → sprawdź czy wczorajszy newsletter dotarł
  (sprawdź zakładkę Spam). Sprawdź czy fromName w CONFIG.SOURCES
  odpowiada dokładnie nazwie nadawcy.

Sprawdź 4 — Logi wykonań
  Triggery → ⋮ przy wpisie startPipeline → "Wyświetl wykonania".
  Szukaj błędów w logach z poprzedniego dnia.

Sprawdź 5 — Strefa czasowa
  Ustawienia projektu → sprawdź czy strefa czasowa to Europe/Warsaw.
  Błędna strefa powoduje, że pipeline odpala o nieoczekiwanej godzinie.


PROBLEM: Artykuły z komunikatem [!] zamiast streszczenia
----------------------------------------------------------

Możliwe przyczyny:

  a) Strona jest za paywallem lub blokuje boty — AND snippet z maila
     był niedostępny lub zbyt krótki.
     → To zachowanie normalne. Artykuł bez snippetu nie może być
       przetłumaczony. Link do oryginału jest zachowany.

  b) Model AI nie odpowiada lub klucz API wygasł.
     → Sprawdź klucz API w Script Properties.
     → Zaloguj się na openrouter.ai i sprawdź status klucza.
     → Uruchom testSingleArticle() i przejrzyj logi.

  c) Model został wycofany z OpenRouter.
     → Zmień OPENROUTER_MODEL na inny dostępny model.


PROBLEM: Artykuły mają opis "skrót z newslettera" zamiast streszczenia
------------------------------------------------------------------------

To nie jest błąd — to mechanizm fallback działający poprawnie.
Strona artykułu była niedostępna, ale snippet z maila TLDR był
wystarczająco długi, więc został przetłumaczony.

Jeśli chcesz zobaczyć jak często to się zdarza — sprawdź logi
z wykonania: szukaj linii "Scraping failed. Translating TLDR snippet".


PROBLEM: Pipeline kończy się wcześniej
---------------------------------------

Komunikat "Max consecutive errors reached. Sending partial report."
oznacza, że 5 artykułów z rzędu zwróciło błąd.

  1. Sprawdź klucz API.
  2. Sprawdź status: https://status.openrouter.ai
  3. Sprawdź czy wybrany model jest aktualnie dostępny.


PROBLEM: testSingleArticle() — "No accessible articles found"
--------------------------------------------------------------

  1. Uruchom showArticles() — jeśli wynik to "Raw: 0", problem
     leży w Gmail (brak newsletterów lub błędny fromName).
  2. Sprawdź czy jest wczorajszy e-mail od TLDR (też w Spamie).
  3. Jeśli artykuły są widoczne w showArticles() ale test nie może
     przetworzyć żadnego — wszystkie strony mogą być w tym momencie
     niedostępne. Poczekaj do dnia gdy przyjdzie nowy newsletter.


PROBLEM: Trigger zniknął z panelu
-----------------------------------

Google Apps Script może usunąć triggery przy błędzie autoryzacji
lub po długim okresie nieaktywności konta.
→ Uruchom setupDailyTrigger().


PROBLEM: Czcionka Ubuntu nie wyświetla się w dokumencie
-------------------------------------------------------

  1. Otwórz dowolny dokument Google Docs.
  2. Format → Tekst → Więcej czcionek → wyszukaj "Ubuntu" → dodaj.

  Alternatywa: zmień wszystkie wystąpienia setFontFamily('Ubuntu')
  w kodzie na 'Roboto' lub 'Open Sans'.


================================================================================
11. OGRANICZENIA TECHNICZNE
================================================================================

  Limit czasu jednej funkcji    6 minut (Google Apps Script)
  Limit artykułów dziennie      4 (konfigurowalny w MAX_TOTAL_ARTICLES)
  Max tekstu do AI              40 000 znaków (~6 000–7 000 słów)
  Interwał między artykułami    5 minut
  Max prób na artykuł           3 (próba 3 używa modelu zapasowego)
  Max błędów z rzędu            5 przed raportem częściowym
  Zasięg czasowy                tylko artykuły z poprzedniego dnia


================================================================================
12. BEZPIECZEŃSTWO
================================================================================

Klucz API
  Przechowywany w zaszyfrowanym magazynie Script Properties.
  Nigdy nie pojawia się w kodzie ani w logach.
  Dostęp do Script Properties ma tylko właściciel projektu.

Zakres działania
  Aplikacja działa wyłącznie w obrębie Twojego konta Google.
  Dane zewnętrzne wysyłane są wyłącznie do:
    - URL artykułów (pobieranie treści stron, tylko GET)
    - OpenRouter API (treść artykułów do streszczenia / snippety do tłumaczenia)

Ryzyko prompt injection
  Złośliwa treść w artykule mogłaby próbować manipulować zachowaniem
  modelu. W praktyce ryzyko jest minimalne — odpowiedź modelu jest
  zwykłym tekstem, nie jest interpretowana jako kod i nie ma dostępu
  do żadnych funkcji aplikacji. Najgorszy efekt to dziwne streszczenie.

Polityka prywatności OpenRouter
  https://openrouter.ai/privacy
  Nie przetwarzaj przez tę aplikację treści poufnych ani osobistych.


================================================================================
SZYBKA ŚCIĄGAWKA — PIERWSZE URUCHOMIENIE
================================================================================

  1. script.google.com → Nowy projekt → wklej kod → Zapisz
  2. Ustawienia projektu → Strefa czasowa → Europe/Warsaw
  3. Ustawienia projektu → Właściwości skryptu → OPENROUTER_API_KEY = sk-or-...
  4. Uruchom testDriveOnly()     → sprawdź logi i skrzynkę Gmail
  5. Uruchom testSingleArticle() → sprawdź logi i TLDR/_debug/ na Drive
  6. Uruchom setupDailyTrigger() → sprawdź panel Triggery (1 wpis)

  Gotowe. Raport będzie czekał jutro rano.


================================================================================
SZYBKA ŚCIĄGAWKA — CODZIENNA OBSŁUGA
================================================================================

  Sprawdź postęp pipeline:      showState()
  Sprawdź wykryte artykuły:     showArticles()
  Pipeline utknął:              emergencyReset() → startPipeline()
  Trigger zniknął:              setupDailyTrigger()
  Przetestuj nowy model AI:     zmień OPENROUTER_MODEL → testSingleArticle()

================================================================================