# knowledge-mcp

---

## SOTA: GraphRAG + Knowledge Graphs (DP.SOTA.004)

> knowledge-mcp = retrieval layer. Цель: vector + graph traversal для multi-hop reasoning.

- Текущее: pgvector для semantic search по summary
- Следующий шаг: graph traversal по typed `related:` полям из frontmatter
- pack_search = semantic view, pack_graph = graph view, pack_get = full entity view
- При индексации: извлекать typed `related:` для построения графа связей

## Personal search: границы действующего контракта

Личный экземпляр использует этот репозиторий с `wrangler.private.toml` и
`MCP_MODE=private`. Его `search` ищет по подключённым личным источникам:
keyword/vector с fallback, без публичного LLM reranking и обогащения родителями.
`source_type` в этом режиме игнорируется; фильтровать источник нужно через `source`.

Прямой private-ответ возвращает индексированный текст без отдельного ограничения
длины фрагментов или общего бюджета байтов. Это может быть чанк, а не весь файл.
Через gateway `personal_search` текст каждого результата дополнительно сокращается
до 1500 единиц UTF-16 плюс маркер; это не ограничение общего размера ответа.
Для чтения выбранного документа используйте `get_document` / `personal_get_document`.

Известный долг приёмки `MCP_BOUNDS`: схема private search заявляет `limit` 1..20,
но private handler передаёт `limit || 5` без нормализации или проверки максимума.
Публичные ограничения 2000 единиц UTF-16 на поле и 32000 UTF-8 байтов на ответ
к private-ветке не применяются. Уточнение метаданных не исправляет этот долг
и не подтверждает ограниченность прямого private-ответа.
