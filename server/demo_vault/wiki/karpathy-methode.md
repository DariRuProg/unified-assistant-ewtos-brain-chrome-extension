# Karpathy-Methode

Die **Karpathy-Methode** organisiert Wissen als von einer KI **kuratiertes Wiki** statt
als Vektor-Datenbank (RAG).

## Kernidee
- Rohquellen (Artikel, Transkripte, Notizen) landen in `raw/`.
- Eine KI destilliert daraus kuratierte, verlinkte Seiten in `wiki/`.
- Der Chat **navigiert** das Wiki wie ein Mensch: liest `index.md`, folgt Wikilinks,
  liest die relevante Seite — und antwortet daraus.

## Warum kein RAG / keine Vektor-DB?
- Das Wiki ist bereits sauber strukturiert — eine Vektor-DB wäre nur Zusatzaufwand.
- Navigation ist **nachvollziehbar** (man sieht, welche Seite die Antwort lieferte),
  **günstiger** (kein Embedding-Index) und **wartbar** (Menschen lesen dasselbe Wiki).

## Verwandt
- [[zweites-gehirn]]
- [[ewtosbrain-features]]
