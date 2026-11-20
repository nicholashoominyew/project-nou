# Bot queue

This page described the first version: one shared chat with Chat and Queue tabs. It has been replaced by the **Bots Hub**, which shows a collaboration room (with rooms, hand-offs and approval cards), a private in-house chat and a bot queue on one page. See [BOTS-HUB.md](BOTS-HUB.md).

What carried over: bots still post with `POST /v1/chat` and a token with `chat:write`, their name still comes from the token, and nothing said in the chat changes a note. Messages written before schema 12 are in the **General** room.
