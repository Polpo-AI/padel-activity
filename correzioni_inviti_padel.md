# Correzioni — Meccanismo di Invito

*Data:* 15 marzo 2026
*Stato:* Da implementare

> **NOTA GENERALE — COMPATIBILITÀ CON IL SISTEMA ESISTENTE**
> Tutte le modifiche descritte in questo documento devono essere implementate in modo compatibile con il codice e la struttura dati già esistenti. Prima di procedere con qualsiasi modifica, verificare lo stato attuale del sistema e segnalare esplicitamente eventuali incompatibilità, conflitti con la logica esistente, o ambiguità di workflow che richiedano una decisione prima dell'implementazione.

> **Scope:** Le modifiche descritte si applicano **esclusivamente alla modalità "ricerca partita"**. La prenotazione diretta di un campo per 4 giocatori (anche sconosciuti, livelli misti, senza vincoli) rimane invariata e non è soggetta a queste regole.

---

## 1. Rimozione della logica "porta un amico"

Eliminare completamente la possibilità, nella modalità ricerca partita, di aggiungere uno o più "+1" non censiti a sistema. Questa funzionalità consente attualmente di portare giocatori privi di livello assegnato, aggirando i vincoli di Skill Test e matching.

- **Identificare e modificare tutto il codice esistente** (frontend e backend) che permette di inserire partecipanti come ospiti o "+1" in una partita aperta in modalità ricerca.
- Dopo la modifica, ogni partecipante a una partita in modalità ricerca deve essere un utente registrato a sistema con livello ≥ 1.0 (Skill Test completato).
- Non sono ammesse eccezioni: nessun partecipante anonimo, nessun ospite esterno, nessun placeholder.

> ⚠️ **Verifica:** mappare tutti i punti del codice in cui è possibile aggiungere un partecipante non censito a una partita in modalità ricerca. Segnalare ogni occorrenza prima di procedere con la rimozione.

---

## 2. Preferenze di gioco — Invito prioritario a giocatori specifici

Chi apre una partita in modalità ricerca può indicare **al massimo 2 giocatori preferiti** con cui vorrebbe giocare. Questi giocatori ricevono un invito prioritario prima che la partita venga aperta alla ricerca generale.

**Regole sui giocatori preferiti:**

- Devono essere utenti registrati a sistema con Skill Test completato (livello ≥ 1.0).
- Devono rientrare nel **range di livello ammesso dalla policy di matching del club** calcolato a partire dal livello di chi apre la partita. Non sono ammesse eccezioni: un preferito fuori range non può essere invitato.
- Se si tenta di indicare un giocatore con livello 0 o fuori range, il sistema mostra un messaggio esplicativo e impedisce la selezione.

**Formato dell'invito prioritario:**

> *"[Nome] vorrebbe invitarti a una partita alle [HH:MM] al campo [Nome campo] il giorno [GG/MM/AAAA]"*

**Contatore inviti giornalieri:**

- Gli inviti prioritari ai giocatori preferiti **non vengono conteggiati** nel limite di inviti giornalieri per utente.
- Solo gli inviti generici inviati nella ricerca partita normale scalano dal contatore.

> ⚠️ **Verifica:** controllare se esiste già un meccanismo di invito prioritario o preferenze di gioco a sistema. Se esiste, adattarlo; se non esiste, crearlo integrandosi con il flusso di apertura partita esistente.

---

## 3. Limite inviti giornalieri — Configurazione e dashboard

- **Verificare** che il numero massimo di inviti giornalieri per utente venga già chiesto in fase di onboarding del club. Se non è presente, aggiungerlo.
- Il gestore deve poter **modificare questo limite in qualsiasi momento dalla dashboard**, senza dover ripetere l'onboarding.
- Il limite è configurabile per club (non per singolo utente).

> ⚠️ **Verifica:** controllare se esiste già un contatore inviti a DB (per utente, per giorno) e come viene resettato. Verificare che la logica di esclusione degli inviti prioritari dal contatore sia implementabile senza riscrivere il meccanismo esistente. Segnalare eventuali criticità.
