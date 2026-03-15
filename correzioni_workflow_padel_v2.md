# Correzioni e Miglioramenti — Workflow Padel

*Data:* 15 marzo 2026
*Stato:* Da implementare

> **NOTA GENERALE — COMPATIBILITÀ CON IL SISTEMA ESISTENTE**
> Tutte le modifiche descritte in questo documento devono essere implementate in modo compatibile con il codice e la struttura dati già esistenti. Prima di procedere con qualsiasi modifica, verificare lo stato attuale del sistema e segnalare esplicitamente eventuali incompatibilità, conflitti con la logica esistente, o ambiguità di workflow che richiedano una decisione prima dell'implementazione.

---

## 1. Sistema livelli giocatori (scala 1.0 – 7.0)

Sostituire l'attuale sistema livelli con la scala internazionale padel 1.0–7.0, ispirata al NTRP (National Tennis Rating Program) e adottata dalla maggior parte dei club e piattaforme (Playtomic, NPRP, ecc.).

*Macro-categorie di riferimento:*

- **1.0 – 2.5 → Principiante:** il giocatore sta imparando le basi, colpi inconsistenti, difficoltà con i vetri e il rovescio.
- **2.6 – 4.0 → Intermedio:** il giocatore sostiene scambi più lunghi, inizia a usare i vetri intenzionalmente, tattica di base con il compagno.
- **4.1 – 5.5 → Avanzato:** tecnica quasi completa, gioco prevalentemente tattico e psicologico, partecipazione a tornei.
- **5.6 – 7.0 → Elite / Pro:** padronanza totale, livello agonistico nazionale/internazionale.

*Granularità del punteggio:* incrementi di 0.1 (es. 1.0, 1.1, 1.2, … 3.7, 3.8, … 7.0).

*Ambito del livello:* il livello del giocatore è **specifico per circolo/club**. Uno stesso giocatore iscritto a più club potrebbe avere livelli diversi in ciascuno, in base alla valutazione effettuata dal maestro di quel circolo. Non esiste un livello "universale" cross-club.

### Punteggio di default per nuovi giocatori

Un giocatore inserito a sistema per la prima volta viene registrato con punteggio **0** (zero). Il valore 0 funge da flag "non ancora valutato": il giocatore esiste a DB ma non ha ancora effettuato lo Skill Test.

- Il giocatore con punteggio 0, se tenta di prenotare una partita o di essere cercato per una partita, riceve un messaggio che lo informa che deve prima effettuare uno **Skill Test** per ottenere il proprio punteggio.
- Nessun giocatore con punteggio 0 può partecipare a partite o comparire nelle ricerche di altri giocatori.

> ⚠️ **Verifica:** controllare se nel DB esiste già un campo livello/punteggio per il giocatore e come è attualmente tipizzato (nullable, stringa, float, ecc.). Adattare di conseguenza, segnalando eventuali migration necessarie.

### Funzione: filtro giocatori per livello

Implementare (o verificare se già esistente) una funzione che permetta di filtrare i giocatori a DB per livello. La funzione deve supportare:

- **Livello esatto:** restituire tutti i giocatori con punteggio = X (es. tutti i giocatori con livello 0 → candidati per l'invito allo Skill Test).
- **Range di livello:** restituire tutti i giocatori con punteggio compreso tra X e Y (es. tutti i giocatori tra 1.0 e 2.5).

*Output:* dati base del giocatore (nome, cognome, contatto/ID).

*Caso d'uso principale:* filtrare i giocatori con livello 0 per inviare loro una comunicazione/invito a prenotare lo Skill Test.

> ⚠️ **Verifica:** se una funzione di filtro simile esiste già, estenderla per supportare entrambe le modalità (esatto e range) senza duplicare la logica.

---

## 2. Policy di matching per livello (configurabile dal club)

La policy di abbinamento tra giocatori è una decisione del club, configurata in fase di onboarding e modificabile successivamente dalla dashboard.

*Parametri configurabili dal gestore:*

- **Range superiore:** di quanto sopra il proprio livello un giocatore può cercare avversari (es. +0.5, +1.0).
- **Range inferiore:** di quanto sotto il proprio livello un giocatore può cercare avversari (es. −0.3, −0.5).
- Il range **non deve essere necessariamente simmetrico** (es. un giocatore 3.5 può cercare da 3.2 a 4.0 se il club imposta −0.3 / +0.5).

*Modalità estrema:* il gestore può anche scegliere una policy "aperta" dove tutti possono giocare con tutti, senza restrizioni di livello.

*Logica di ricerca giocatori:* quando un giocatore apre una partita, il sistema cerca compagni/avversari il cui livello rientra nel range calcolato a partire dal livello di chi apre la partita, applicando i limiti impostati dal club. **Questa logica deve essere adattata e integrata con il sistema di prioritizzazione dei giocatori già esistente, senza sovrascriverlo.**

> ⚠️ **Verifica:** identificare la logica di prioritizzazione attualmente in uso per la ricerca giocatori e assicurarsi che il filtro per range di livello si innesti su di essa in modo coerente. Segnalare eventuali conflitti o ambiguità.

---

## 3. Skill Test obbligatorio

Ogni nuovo giocatore deve effettuare uno "Skill Test" — una lezione di valutazione — prima di poter accedere alle funzionalità di prenotazione e ricerca partita.

*Parametri dello Skill Test (configurabili dal gestore in onboarding):*

- Durata (es. 30 min, 60 min)
- Orari disponibili
- Costo
- Chi effettua la valutazione (maestro interno, ecc.)

*Caratteristiche:*

- Lo Skill Test è **ripetibile su richiesta** del giocatore (es. per ricalcolare il livello dopo un periodo di allenamento).
- Il livello risultante dallo Skill Test diventa il punteggio ufficiale del giocatore nel sistema.
- I giocatori con punteggio 0 non sono autorizzati a prenotare o essere cercati (vedi §1).

> ⚠️ **Verifica:** verificare se esiste già un tipo di prenotazione "lezione" o "valutazione" a sistema e se può essere riutilizzato/esteso per lo Skill Test, oppure se va creato ex novo.

---

## 4. Onboarding — Dettagli sui campi

Rivedere la sezione onboarding per raccogliere informazioni più granulari sui campi del club.

*Dati richiesti per ogni campo:*

- Nome del campo (es. "Campo 1", "Campo Centrale")
- Tipologia: coperto o scoperto
- Eventuali note (superficie, illuminazione, ecc.)

Il numero totale di campi deve essere raccolto in modo esplicito, e per ciascuno deve essere specificata la tipologia coperto/scoperto — non è sufficiente chiedere genericamente quanti campi ci sono.

> ⚠️ **Verifica:** controllare se la struttura dati dei campi esiste già a DB e quali campi sono già presenti. Aggiungere solo i campi mancanti, segnalando eventuali migration necessarie.

---

## 5. Costi campo — Configurazione oraria e per tipologia

La partita di padel ha una durata standard di **90 minuti**. Il sistema di pricing deve tenerne conto.

### 5.1 Configurazione in onboarding

In fase di onboarding il gestore inserisce i costi per ogni campo, per ogni fascia oraria.

*Logica di pricing:*

- Il prezzo viene configurato **per slot orario** (ora per ora), ma il costo della sessione di 90 minuti si calcola applicando **la tariffa oraria più alta** tra gli slot coinvolti, moltiplicata per 1,5 (90 min = 1,5 ore).
- Esempio: se una partita va dalle 15:00 alle 16:30, e lo slot 15-16 costa €40/h mentre lo slot 16-17 costa €50/h, il costo sessione = €50 × 1,5 = **€75**.
- Questo approccio è a tutela del club: si applica sempre la fascia più alta coinvolta nella prenotazione.
- Il prezzo varia in base a: orario, tipo di campo (coperto/scoperto), e periodo.

### 5.2 Modifica dalla dashboard

Il gestore deve poter modificare i costi in qualsiasi momento dalla dashboard:

- **Campo per campo:** ogni campo ha la propria tabella prezzi.
- **Orario per orario:** modifica granulare ora per ora.
- **Per periodo:** possibilità di impostare tariffe diverse per periodi specifici (es. "dal 1 giugno al 30 settembre, il Campo 2 coperto dalle 15 alle 21 costa X").

Questo permette flessibilità stagionale senza dover riconfigurare tutto ogni mese.

> ⚠️ **Verifica:** verificare se esiste già un modello di pricing a DB e come è strutturato. Segnalare eventuali incompatibilità con la logica "fascia più alta" descritta sopra.

---


## 7. Partita mista o stesso sesso — Scelta al momento della prenotazione

La scelta mista/stesso sesso viene fatta **al momento della prenotazione**, direttamente in chat da chi apre la partita:

- "Cerco partita mista"
- "Cerco partita solo uomini / solo donne"

Questo rende il sistema più flessibile e rispetta le preferenze partita per partita.

> ⚠️ **Verifica:** verificare se esistono altri punti nel flusso in cui questa preferenza viene raccolta o salvata a DB, e allinearli con questa nuova logica.

---

## 8. Reminder prezzo nella conferma

Quando un giocatore conferma la partecipazione a una partita, il sistema invia un **reminder** che include:

- **Prezzo totale** della sessione (costo campo diviso per i giocatori)
- Campo assegnato (nome, coperto/scoperto)
- Data e orario
- Giocatori confermati

Il prezzo deve essere visibile a ogni giocatore **prima della conferma definitiva**, in modo che possa decidere consapevolmente.

> ⚠️ **Verifica:** verificare se esiste già un sistema di notifica/reminder nella conferma prenotazione e aggiungere le informazioni mancanti senza riscrivere l'intero flusso.

---

## 9. Feedback post-partita

Al termine di ogni partita, al giocatore viene chiesto un feedback libero leggero e rapido. Il feedback è composto da:

*Requisiti di persistenza a DB:*

- La nota deve essere collegata a:
  - Il **giocatore** che l'ha scritta (ID utente)
  - Il **campo** su cui si è svolta la partita (ID campo)
  - La **partita** di riferimento (ID partita / prenotazione)
  - Il **timestamp** della partita
- Il feedback è visibile **solo al gestore del club**, non agli altri giocatori.
- Il gestore può usare le note aggregate per valutare lo stato dei campi e pianificare manutenzione, o uno studio dei dati per possibili miglioramenti.

> ⚠️ **Verifica:** se esiste già una struttura di feedback post-partita a DB, estenderla aggiungendo il campo note testuali e le foreign key necessarie, senza creare una tabella parallela. Segnalare eventuali conflitti.

---

## 10. Suggerimenti aggiuntivi (da valutare)

### 10.1 Rivalutazione periodica del livello

Prevedere un meccanismo opzionale per rivalutare il livello dei giocatori nel tempo (es. ogni 6 mesi, o dopo N partite), per evitare che i punteggi diventino obsoleti. Potrebbe essere un semplice promemoria al giocatore di riprenotare lo Skill Test.

### 10.2 Tariffe stagionali predefinite

Oltre alla modifica manuale per periodo, offrire la possibilità di creare "profili tariffari stagionali" riutilizzabili (es. "Tariffa Estiva", "Tariffa Invernale") da applicare in blocco ai campi, per semplificare la gestione.

---

## Riepilogo modifiche

| # | Area | Tipo | Priorità |
|---|------|------|----------|
| 1 | Livelli 1.0–7.0 + punteggio 0 per nuovi giocatori + filtro per livello/range | Correzione + nuova feature | Alta |
| 2 | Policy matching (range asimmetrico, configurabile dal club, adattata alla prioritizzazione esistente) | Correzione | Alta |
| 3 | Skill Test obbligatorio e ripetibile | Nuova feature | Alta |
| 4 | Onboarding campi (nome, coperto/scoperto) | Correzione | Alta |
| 5 | Costi campo per orario/tipo/periodo | Correzione + nuova feature | Alta |
| 6 | Chat per fasce di livello (solo dopo Skill Test) | Correzione | Media |
| 7 | Mista/stesso sesso → scelta in chat al momento della prenotazione | Correzione | Media |
| 8 | Reminder prezzo in conferma | Nuova feature | Alta |
| 9 | Feedback post-partita con nota campo collegata a giocatore + campo + partita | Nuova feature | Media |
| 10 | Suggerimenti (rivalutazione periodica, tariffe stagionali) | Da valutare | Bassa |
