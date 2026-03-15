# Prompt — Modifica Sistema di Invito a Ondate con EMA Individuale

> **NOTA GENERALE — COMPATIBILITÀ CON IL SISTEMA ESISTENTE**
> Tutte le modifiche descritte devono essere implementate in modo compatibile con il codice e la struttura dati già esistenti. Prima di procedere con qualsiasi modifica, analizza il codice attuale, e segnala esplicitamente eventuali incompatibilità, conflitti con la logica esistente, o ambiguità di workflow che richiedano una decisione prima dell'implementazione.

---

## Contesto — Sistema attuale

Il sistema attuale di invito a ondate usa un **moltiplicatore collettivo** (default ×3) che varia in base all'affidabilità *media* del gruppo da chiamare in quella ondata:

- Affidabilità media > 50% → moltiplicatore ×2
- Affidabilità media 30–50% → moltiplicatore ×3 (default)
- Affidabilità media < 30% → moltiplicatore ×4

Il numero di persone da chiamare si calcola quindi come `posti_da_coprire × moltiplicatore`.

Ogni giocatore ha già a sistema un **Reliability Score** calcolato tramite EMA (Media Mobile Esponenziale):
```
NuovoScore = (85% × VecchioScore) + (15% × Evento)
```
dove Evento = 1 se il giocatore ha accettato e giocato, 0 se ha rifiutato, non risposto o dato buca.

Il sistema funziona già a ondate (wave): se dopo la prima ondata non tutti i posti sono coperti, parte una seconda ondata per i posti residui, e così via.

---

## Modifica richiesta

Sostituire il moltiplicatore collettivo con una **logica di selezione per-persona basata sull'EMA individuale**. L'obiettivo è sempre lo stesso (coprire i posti disponibili), ma invece di applicare un moltiplicatore fisso al gruppo, il sistema accumula giocatori uno per uno finché la somma delle loro probabilità di risposta positiva copre i posti da riempire.

### Nuovo algoritmo di selezione per ondata

Il sistema scorre la lista dei giocatori eligibili in ordine di priorità (la logica di prioritizzazione esistente va mantenuta e non sovrascritta) e li accumula finché la **somma cumulativa delle EMA individuali** raggiunge il numero di posti da coprire nell'ondata corrente:

```
while Somma(EMA_i) < Posti_da_coprire_ondata_corrente:
    aggiungi prossimo giocatore eligibile alla lista di invito
```

Non appena la soglia viene raggiunta, il sistema invia gli inviti a tutti i giocatori accumulati fino a quel momento.

**Esempio — Wave 1 con 4 posti da coprire:**

| Giocatore | EMA individuale | Cumulo |
|-----------|----------------|--------|
| Mario     | 0.80           | 0.80   |
| Luca      | 0.70           | 1.50   |
| Sara      | 0.60           | 2.10   |
| Giulia    | 0.55           | 2.65   |
| Marco     | 0.50           | 3.15   |
| Anna      | 0.45           | 3.60   |
| Paolo     | 0.40           | 4.00 ← soglia raggiunta, stop |

Risultato: vengono invitati 7 giocatori (non 12 come con il moltiplicatore fisso ×3), perché il loro cumulo EMA copre esattamente i 4 posti.

**Esempio — Wave 1 con lista di giocatori poco affidabili (4 posti):**

| Giocatore | EMA individuale | Cumulo |
|-----------|----------------|--------|
| A         | 0.20           | 0.20   |
| B         | 0.18           | 0.38   |
| C         | 0.22           | 0.60   |
| D         | 0.15           | 0.75   |
| E         | 0.20           | 0.95   |
| F         | 0.25           | 1.20   |
| G         | 0.18           | 1.38   |
| H         | 0.22           | 1.60   |
| I         | 0.20           | 1.80   |
| L         | 0.25           | 2.05   |
| M         | 0.22           | 2.27   |
| N         | 0.20           | 2.47   |
| O         | 0.28           | 2.75   |
| P         | 0.30           | 3.05   |
| Q         | 0.25           | 3.30   |
| R         | 0.22           | 3.52   |
| S         | 0.28           | 3.80   |
| T         | 0.22           | 4.02 ← soglia raggiunta, stop |

Risultato: vengono invitati 18 giocatori, perché ognuno ha bassa affidabilità individuale.

### Logica ondate successive

Ogni ondata successiva lavora **sui posti residui al momento dell'invio**, non sui posti totali originali. Se dopo la wave 1 si sono confermati 2 giocatori su 4, la wave 2 deve coprire solo 2 posti:

```
Posti_da_coprire_ondata_corrente = Posti_totali - Giocatori_confermati
```

L'algoritmo di accumulo EMA si applica identicamente, ma la soglia da raggiungere è quella dei posti residui.

**Esempio — Wave 2 con 2 posti residui:**

| Giocatore | EMA individuale | Cumulo |
|-----------|----------------|--------|
| Federica  | 0.75           | 0.75   |
| Giovanni  | 0.65           | 1.40   |
| Chiara    | 0.60           | 2.00 ← soglia raggiunta, stop |

Risultato: vengono invitati 3 giocatori per coprire i 2 posti residui.

---

## Aggiornamento EMA dopo ogni partita

L'EMA di ogni giocatore deve essere aggiornata al termine di ogni partita, per ogni giocatore che era stato invitato. La formula rimane quella esistente:

```
NuovoScore = (85% × VecchioScore) + (15% × Evento)
```

Valori dell'Evento:
- `1.0` → ha accettato e giocato
- `1.3` → ha accettato e giocato con invito last-minute (< 2 ore dalla partita) — il cosiddetto "bonus eroismo", che prima era un moltiplicatore separato, viene ora integrato direttamente come valore evento nell'aggiornamento EMA
- `0.0` → ha rifiutato, non ha risposto, o ha dato buca

> ⚠️ **Verifica:** controllare dove e come viene attualmente aggiornato il Reliability Score a DB dopo una partita, e adattare quel punto per usare il valore 1.3 in caso di accettazione last-minute, senza creare un percorso parallelo di aggiornamento.

---

## Gestione esaurimento lista

Se la lista dei giocatori eligibili si esaurisce prima che la somma cumulativa EMA raggiunga la soglia dei posti da coprire, il sistema **non invia ulteriori ondate** e attende le risposte degli inviti già inviati.

Non appena si verifica la condizione:
```
Giocatori_invitati_in_attesa + Giocatori_confermati < Giocatori_richiesti
```
e non ci sono più giocatori eligibili da chiamare, il sistema:

1. **Annulla la partita**
2. **Notifica tutti i giocatori** già coinvolti (confermati e in attesa)

> ⚠️ **Verifica — punto critico:** controllare se esiste già nel codice un meccanismo che monitora il rapporto tra `giocatori_invitati` e `giocatori_richiesti`. In particolare, verificare se lo stato della partita viene aggiornato **anche quando un giocatore risponde "no"** e non solo quando risponde "sì" — questo è essenziale perché la condizione di annullamento si basa sui posti ancora copribili, non solo su quelli già confermati. Segnalare eventuali gap.

---

## Riepilogo modifiche

| # | Area | Tipo | Priorità |
|---|------|------|----------|
| 1 | Sostituzione moltiplicatore collettivo con accumulo EMA individuale per ondata | Modifica core | Alta |
| 2 | Logica ondate: soglia calcolata sui posti residui, non sui posti totali | Modifica core | Alta |
| 3 | Aggiornamento EMA post-partita: evento last-minute vale 1.3 invece di 1.0 | Modifica | Alta |
| 4 | Gestione esaurimento lista: annullamento partita e notifica se posti non copribili | Correzione + verifica | Alta |
